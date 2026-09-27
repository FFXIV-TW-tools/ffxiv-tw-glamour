// 台服 client Item 表 → 裝備結構欄位中間檔（名稱只供與 tclocal_Item.csv 比對，正式名稱由 build-items.py 取 tclocal）。
// 用法：dotnet run --project tools/data/charamake-export -c Release -- items <輸出檔>
// 欄位以「位移＋型別」定位（2026-09-27 dump 台服 client：貓魅單衣 2990 Model 131161＝set 89 variant 2、EquipRestriction 11）。
using System.Text.Encodings.Web;
using System.Text.Json;
using Lumina;
using Lumina.Data.Structs.Excel;
using Lumina.Excel;

static class ItemExport
{
    public static void Run(GameData gd, string output)
    {
        var sheet = gd.Excel.GetSheet<RawRow>(name: "Item")!;
        int Col(int offset, ExcelColumnDataType type)
        {
            for (var i = 0; i < sheet.Columns.Count; i++)
            {
                var column = sheet.Columns[i];
                if (column.Offset != offset) continue;
                if (column.Type != type) throw new InvalidDataException($"Item 位移 {offset} 型別 {column.Type}，預期 {type}");
                return i;
            }
            throw new InvalidDataException($"Item 缺少位移 {offset} 的欄位");
        }
        int name = Col(0, ExcelColumnDataType.String), icon = Col(136, ExcelColumnDataType.UInt16), ilvl = Col(138, ExcelColumnDataType.UInt16),
            rarity = Col(150, ExcelColumnDataType.UInt8), slot = Col(154, ExcelColumnDataType.UInt8), dye = Col(156, ExcelColumnDataType.UInt8),
            equipLevel = Col(78, ExcelColumnDataType.UInt8), restriction = Col(80, ExcelColumnDataType.UInt8),
            job = Col(81, ExcelColumnDataType.UInt8), model = Col(24, ExcelColumnDataType.UInt64);
        // 每列：[id, client 名稱, EquipSlotCategory, set, variant, DyeCount, Icon, Level{Item}, Level{Equip}, Rarity, EquipRestriction, ClassJobCategory]
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
        using var stream = File.Create(output);
        using var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        writer.WriteStartArray();
        var count = 0;
        foreach (var r in sheet)
        {
            var m = r.ReadUInt64Column(model);
            writer.WriteStartArray();
            writer.WriteNumberValue(r.RowId);
            writer.WriteStringValue(r.ReadStringColumn(name).ExtractText());
            writer.WriteNumberValue(r.ReadUInt8Column(slot));
            writer.WriteNumberValue((int)(m & 0xffff));
            writer.WriteNumberValue((int)((m >> 16) & 0xffff));
            writer.WriteNumberValue(r.ReadUInt8Column(dye));
            writer.WriteNumberValue(r.ReadUInt16Column(icon));
            writer.WriteNumberValue(r.ReadUInt16Column(ilvl));
            writer.WriteNumberValue(r.ReadUInt8Column(equipLevel));
            writer.WriteNumberValue(r.ReadUInt8Column(rarity));
            writer.WriteNumberValue(r.ReadUInt8Column(restriction));
            writer.WriteNumberValue(r.ReadUInt8Column(job));
            writer.WriteEndArray();
            count++;
        }
        writer.WriteEndArray();
        writer.Flush();
        Console.WriteLine($"{output}: {count} 列");
    }
}
