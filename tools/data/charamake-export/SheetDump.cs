// 檢查用：列出台服 client 某張 Excel 表的欄位（型別@位移）與指定列的原始值，用來核對 Lumina 結構與台服版是否一致。
// 用法：dotnet run --project tools/data/charamake-export -- dump <Sheet> [rowId ...]
using Lumina;
using Lumina.Data.Structs.Excel;
using Lumina.Excel;

static class SheetDump
{
    public static string Cell(RawRow row, int i, ExcelColumnDataType t) => t switch
    {
        ExcelColumnDataType.String => row.ReadStringColumn(i).ExtractText(),
        _ => row.ReadColumn(i).ToString() ?? "",
    };

    public static void Run(GameData gd, string name, IEnumerable<uint> ids)
    {
        var sheet = gd.Excel.GetSheet<RawRow>(name: name)!;
        Console.WriteLine($"{name}: {sheet.Count} rows, {sheet.Columns.Count} columns");
        // 一欄一行：欄號、型別@位移，接著各指定列的值（tab 分隔）
        var rows = ids.Where(sheet.HasRow).Select(sheet.GetRow).ToList();
        Console.WriteLine("col\ttype@offset\t" + string.Join("\t", rows.Select(r => r.RowId)));
        for (var i = 0; i < sheet.Columns.Count; i++)
        {
            var c = sheet.Columns[i];
            Console.WriteLine($"{i}\t{c.Type}@{c.Offset}\t" + string.Join("\t", rows.Select(r => Cell(r, i, c.Type))));
        }
    }
}
