// 台服 client 資料匯出器（Lumina）。
// 用法（repo 根目錄）：dotnet run --project tools/data/charamake-export -c Release -- <指令> [參數]
//   dump <Sheet> [rowId ...]   列出欄位與原始值（核對用）
using Lumina;

const string SqPack = @"C:\Games\USERJOY GAMES\FINAL FANTASY XIV TC\game\sqpack";
var gd = new GameData(SqPack, new LuminaOptions { PanicOnSheetChecksumMismatch = false, DefaultExcelLanguage = Lumina.Data.Language.TraditionalChinese });
switch (args.FirstOrDefault())
{
    case "dump": SheetDump.Run(gd, args[1], args.Skip(2).Select(uint.Parse)); break;
    case "items": ItemExport.Run(gd, args[1]); break;
    case "export": Export.Run(gd, Path.GetFullPath(args.ElementAtOrDefault(1) ?? "."), !args.Contains("--no-reference")); break;
    case "restriction-probe": RestrictionProbe.Run(gd); break;
    case "menus":
        foreach (var r in MenuSheet.Read(gd, args.ElementAtOrDefault(1) ?? "CharaMakeType").Take(2))
        {
            Console.WriteLine($"{r.RowId}: race={r.Race} tribe={r.Tribe} gender={r.Gender}");
            foreach (var m in r.Menus.Where(m => m.Lobby != 0))
                Console.WriteLine($"  [{m.Index}] lobby={m.Lobby} index={m.Customize} type={m.Type} num={m.Num} init={m.InitVal} mask={m.Mask} params={string.Join(',', m.Params.Take(Math.Min(m.Num, (byte)12)))}");
            Console.WriteLine($"  icons={string.Join(',', r.FeatureIcons[0])}");
        }
        break;
    default: Console.Error.WriteLine("指令：export、items <輸出檔>、restriction-probe、dump、menus"); Environment.Exit(2); break;
}
