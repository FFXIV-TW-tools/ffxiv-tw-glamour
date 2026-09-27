// CharaMakeType／HairMakeType／CharaMakeCustomize + Lobby 原始表 → 每種族／部族／性別可選選項。
// 從 repo 根目錄執行：dotnet run --project tools/data/charamake-export -c Release -- export
using Microsoft.VisualBasic.FileIO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Lumina;
using Lumina.Excel;

static class Export
{
    static readonly JsonSerializerOptions Json = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, WriteIndented = false };
    static void Save(string path, object data)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(data, Json));
        Console.WriteLine($"{path}: {new FileInfo(path).Length} bytes");
    }

    public static void Run(GameData gd, string root, bool includeReferenceTerms = true)
    {
        var itemDir = Path.Combine(root, "data", "items");
        var slotFiles = new[] { "met", "top", "glv", "dwn", "sho", "ear", "nek", "wrs", "rir" }
            .Select(slot => Path.Combine(itemDir, slot + ".json"));
        var jobs = new SortedSet<int>(slotFiles.SelectMany(file =>
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            return doc.RootElement.GetProperty("rows").EnumerateArray().Select(row => row[11].GetInt32()).ToArray();
        }));
        var jobSheet = gd.Excel.GetSheet<RawRow>(name: "ClassJobCategory")!;
        var jobNames = new SortedDictionary<int, string>();
        foreach (var id in jobs)
        {
            var name = jobSheet.HasRow((uint)id) ? jobSheet.GetRow((uint)id).ReadStringColumn(0).ExtractText() : "";
            jobNames[id] = name;
            if (string.IsNullOrWhiteSpace(name)) Console.Error.WriteLine($"ClassJobCategory {id}: 台服名稱空白／列不存在");
        }
        Save(Path.Combine(root, "data", "job-categories.json"), jobNames);

        // tclocal_Item.csv 是台服 client 自解包的名稱權威；HairMakeType 的 unlockItem 要對玩家顯示此名稱。
        using var parser = new TextFieldParser(@"C:\FFXIVProject\data\item_dict\datamining_tc\tclocal_Item.csv", Encoding.UTF8);
        parser.SetDelimiters(",");
        parser.HasFieldsEnclosedInQuotes = true;
        var unlockNames = new Dictionary<uint, string>();
        while (!parser.EndOfData)
        {
            var fields = parser.ReadFields();
            if (fields?.Length > 1 && uint.TryParse(fields[0], out var id) && !string.IsNullOrEmpty(fields[1]))
                unlockNames[id] = fields[1];
        }

        if (includeReferenceTerms)
        {
            var terms = new SortedDictionary<string, SortedDictionary<uint, string>>();
            foreach (var sheetName in new[] { "Addon", "Lobby" })
            {
                var sheet = gd.Excel.GetSheet<RawRow>(name: sheetName)!;
                var found = new SortedDictionary<uint, string>();
                foreach (var row in sheet)
                {
                    // Addon 只有一欄；Lobby 的字串欄依偏移為 0、4、8。
                    var text = sheetName == "Addon" ? row.ReadStringColumn(0).ExtractText()
                        : string.Join("\n", new[] { 3, 4, 5 }.Select(i => row.ReadStringColumn(i).ExtractText()).Where(s => !string.IsNullOrWhiteSpace(s)));
                    if (new[] { "外貌", "美容", "保存", "角色製作", "幻化", "投影" }.Any(text.Contains)) found[row.RowId] = text;
                }
                terms[sheetName] = found;
                Console.WriteLine($"{sheetName} 官方用語: {found.Count} 列");
            }
            Save(Path.Combine(root, "docs", "reference", "ui-terms.json"), terms);
        }

        var lobby = gd.Excel.GetSheet<RawRow>(name: "Lobby")!;
        string Label(uint id) => id != 0 && lobby.HasRow(id) ? lobby.GetRow(id).ReadStringColumn(3).ExtractText() : "";
        var customize = gd.Excel.GetSheet<RawRow>(name: "CharaMakeCustomize")!;
        var creation = MenuSheet.Read(gd, "CharaMakeType").ToDictionary(r => (r.Race, r.Tribe, r.Gender));
        var hair = MenuSheet.Read(gd, "HairMakeType").ToDictionary(r => (r.Race, r.Tribe, r.Gender));
        var codes = new SortedDictionary<string, object>();
        foreach (var row in creation.Values.OrderBy(r => r.Race).ThenBy(r => r.Tribe).ThenBy(r => r.Gender))
        {
            var code = ModelCode(row.Race, row.Tribe, row.Gender);
            if (!codes.ContainsKey(code)) codes[code] = new SortedDictionary<string, object>();
            var variants = (SortedDictionary<string, object>)codes[code];
            var hm = hair[(row.Race, row.Tribe, row.Gender)];
            Menu? Find(uint idx) => row.Menus.FirstOrDefault(m => m.Lobby != 0 && m.Customize == idx);
            Menu? HairFind(uint idx) => hm.Menus.FirstOrDefault(m => m.Lobby != 0 && m.Customize == idx);
            object? Range(uint idx) => Find(idx) is { } m ? new { label = Label(m.Lobby), min = m.Type == 5 ? (int)m.Params[2] : 0,
                max = m.Type == 5 ? (int)m.Params[3] : m.Num - 1, count = m.Type == 5 ? (int)(m.Params[3] - m.Params[2] + 1) : m.Num } : null;
            // Type 1 的選項多數是 SubMenuParam → CharaMakeCustomize；臉型／尾巴為直接圖示。
            // 臉型 icon 尾兩位即遊戲 face id（維艾拉 icon ...05–08 對應 face 5–8）；尾巴圖示尾碼不是 id。
            object[] Options(Menu? m, bool directIcons = false, bool faceIcons = false, HashSet<byte>? defaults = null)
            {
                if (m is null) return [];
                var output = new List<object>();
                for (int k = 0; k < m.Num; k++)
                {
                    var key = m.Params[k];
                    if (directIcons) { output.Add(new { id = faceIcons ? (int)(key % 100) : k + 1, icon = key }); continue; }
                    if (!customize.HasRow(key)) throw new InvalidDataException($"CharaMakeCustomize {key} 不存在：{row.RowId}/{m.Lobby}");
                    var opt = customize.GetRow(key);
                    var id = opt.ReadUInt8Column(0);
                    if (defaults is not null)
                    {
                        var unlockItem = opt.ReadUInt32Column(5);
                        var hairOption = new Dictionary<string, object> {
                            ["id"] = id, ["icon"] = opt.ReadUInt32Column(1), ["isDefault"] = defaults.Contains(id),
                            ["unlockable"] = opt.ReadBoolColumn(3), ["unlockItem"] = unlockItem, ["sheetRow"] = key,
                        };
                        if (unlockNames.TryGetValue(unlockItem, out var unlockName)) hairOption["unlockName"] = unlockName;
                        output.Add(hairOption);
                    }
                    else
                        output.Add(new { id, icon = opt.ReadUInt32Column(1),
                            unlockable = opt.ReadBoolColumn(3), unlockItem = opt.ReadUInt32Column(5), sheetRow = key });
                }
                return output.ToArray();
            }
            var face = Find(5);
            var defaultHairMenu = Find(6)!;
            var defaultHairIds = defaultHairMenu.Params.Take(defaultHairMenu.Num).Select(key => customize.GetRow(key).ReadUInt8Column(0)).ToArray();
            var allHair = Options(HairFind(6), defaults: defaultHairIds.ToHashSet());
            var facePaint = Options(Find(24));
            var raceFeature = Options(Find(22), true);
            var option = new
            {
                source = new { charaMakeType = row.RowId, hairMakeType = hm.RowId, race = row.Race, clan = row.Tribe, gender = row.Gender },
                labels = row.Menus.Where(m => m.Lobby != 0).ToDictionary(m => m.Customize.ToString() + "-" + m.Index, m => Label(m.Lobby)),
                faces = new { label = face is null ? "" : Label(face.Lobby), options = Options(face, true, true) },
                hair = new { label = Label(HairFind(6)!.Lobby), options = allHair,
                    defaultIds = defaultHairIds },
                facePaint = new { label = Label(Find(24)!.Lobby), options = facePaint },
                raceFeature = Find(22) is { } feature ? new { label = Label(feature.Lobby), options = raceFeature } : null,
                faceFeatureIcons = row.FeatureIcons,
                ranges = new { height = Range(3), muscleOrTailLength = Range(21), bust = Range(23), brows = Range(14), eyeShape = Range(16),
                    nose = Range(17), jaw = Range(18), mouth = Range(19), highlights = new { min = 0, max = 1 }, lipstick = new { min = 0, max = 1 } },
                colors = new Dictionary<string, object?> {
                    ["skin"] = Color(8, "clanSkin"), ["hairColor"] = Color(10, "clanHair"),
                    ["eyeRight"] = Color(9, "eye"), ["eyeLeft"] = Color(9, "eye"),
                    ["highlightColor"] = Color(10, "highlight"), ["lipColor"] = Color(20, "lip"),
                    ["tattooColor"] = Color(13, "features"), ["paintColor"] = Color(25, "facePaint") },
            };
            object? Color(uint idx, string palette) => Find(idx) is { } m
                ? new { label = palette == "highlight" ? Label(237) : Label(m.Lobby), palette, count = m.Num } : null;
            variants[row.Tribe + "-" + row.Gender] = option;
        }
        var charaDir = Path.Combine(root, "data", "charamake");
        foreach (var (code, variants) in codes)
            Save(Path.Combine(charaDir, code + ".json"), variants);
        Console.WriteLine($"{codes.Count} 模型碼、{creation.Count} 部族性別列");
    }

    static string ModelCode(int race, int clan, int gender)
    {
        var code = race switch { 1 => clan == 1 ? (gender == 0 ? 101 : 201) : (gender == 0 ? 301 : 401),
            2 => gender == 0 ? 501 : 601, 3 => gender == 0 ? 1101 : 1201,
            4 => gender == 0 ? 701 : 801, 5 => gender == 0 ? 901 : 1001,
            6 => gender == 0 ? 1301 : 1401, 7 => gender == 0 ? 1501 : 1601,
            8 => gender == 0 ? 1701 : 1801, _ => throw new InvalidDataException($"未支援 Race {race}") };
        return $"c{code:0000}";
    }
}

