// 讀台服 CharaMakeType／HairMakeType 的原始欄位。Lumina.Excel 7.5 的 CharaMakeType 結構與台服版面不合（讀 Race 即越界），
// 所以一律以「位移」找欄：兩表的選單結構都是每格 428 bytes（2026-09-27 以 dump 實查台服 client）：
//   +0 Menu（Lobby 列）u32、+4 SubMenuMask u32、+8 Customize（外貌參數索引）u32、+12 SubMenuParam[100] u32、
//   +412 InitVal u8、+413 SubMenuType u8、+414 SubMenuNum u8、+415 LookAt u8、+416 SubMenuGraphic[10] u8。
// 選單格之後：CharaMakeType 為 Voice u8[12]、臉部特徵圖示 Int32[8][7]、預設裝備 u64[21]，最後 Race／Tribe Int32 與 Gender Int8；
// HairMakeType 為臉部特徵圖示 Int32[8][7] 後接 Race／Tribe／Gender。
using Lumina;
using Lumina.Excel;

sealed record Menu(int Index, uint Lobby, uint Mask, uint Customize, uint[] Params, byte InitVal, byte Type, byte Num, byte LookAt, byte[] Graphics);

sealed record MenuRow(uint RowId, int Race, int Tribe, int Gender, Menu[] Menus, int[][] FeatureIcons);

static class MenuSheet
{
    const int Stride = 428;

    public static List<MenuRow> Read(GameData gd, string name)
    {
        var sheet = gd.Excel.GetSheet<RawRow>(name: name)!;
        // 位移 → 欄號（同位移只會有一欄；PackedBool 例外但這兩表沒有）
        var col = sheet.Columns.Select((c, i) => (c.Offset, i)).ToDictionary(x => (int)x.Offset, x => x.i);
        var menuCount = 0;
        while (col.ContainsKey(menuCount * Stride) && col.ContainsKey(menuCount * Stride + 415)) menuCount++;
        // Race／Tribe／Gender 是表尾的 Int32、Int32、Int8（欄 0–2）
        int raceCol = 0, tribeCol = 1, genderCol = 2;
        // 臉部特徵圖示 [8 臉][7 格]：CharaMakeType 在 12 bytes 聲音選項後；HairMakeType 緊接選單。
        var featBase = menuCount * Stride + (name == "CharaMakeType" ? 12 : 0);
        if (!col.ContainsKey(featBase + 8 * 7 * 4 - 4)) throw new InvalidDataException($"{name}: 臉部特徵圖示欄位不符");
        var rows = new List<MenuRow>();
        foreach (var r in sheet)
        {
            var menus = new Menu[menuCount];
            for (var m = 0; m < menuCount; m++)
            {
                var b = m * Stride;
                uint U32(int off) => r.ReadUInt32Column(col[b + off]);
                byte U8(int off) => r.ReadUInt8Column(col[b + off]);
                menus[m] = new Menu(m, U32(0), U32(4), U32(8),
                    Enumerable.Range(0, 100).Select(k => U32(12 + k * 4)).ToArray(),
                    U8(412), U8(413), U8(414), U8(415),
                    Enumerable.Range(0, 10).Select(k => U8(416 + k)).ToArray());
            }
            // 圖示 [臉][特徵]：位移 featBase + 臉*28 + 特徵*4（HairMakeType 列 1：3852=131311、3856=131312、3880=131321）
            var icons = Enumerable.Range(0, 8).Select(f =>
                Enumerable.Range(0, 7).Select(k => r.ReadInt32Column(col[featBase + f * 28 + k * 4])).ToArray()).ToArray();
            rows.Add(new MenuRow(r.RowId, r.ReadInt32Column(raceCol), r.ReadInt32Column(tribeCol), r.ReadInt8Column(genderCol), menus, icons));
        }
        return rows;
    }
}
