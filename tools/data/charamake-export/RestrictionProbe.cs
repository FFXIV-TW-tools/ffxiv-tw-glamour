// 查台服 client 各族外觀模型是否存在：用裝備 set 與 slot 實際路徑交叉核對 EquipRestriction 實例。
using Lumina;

static class RestrictionProbe
{
    static readonly int[] Models = [101, 201, 301, 401, 501, 601, 701, 801, 901, 1001, 1101, 1201, 1301, 1401, 1501, 1601, 1701, 1801];
    public static void Run(GameData gd)
    {
        foreach (var (restriction, set) in new[] { (2, 59), (3, 59), (4, 84), (5, 85), (6, 86), (7, 87),
                 (8, 92), (9, 93), (10, 88), (11, 89), (12, 90), (13, 91), (14, 257), (15, 258),
                 (16, 597), (17, 581), (18, 744), (19, 829) })
        {
            var existing = Models.Where(code => gd.FileExists($"chara/equipment/e{set:0000}/model/c{code:0000}e{set:0000}_top.mdl"));
            Console.WriteLine($"restriction={restriction} set={set} directModels=[{string.Join(',', existing.Select(c => $"c{c:0000}"))}]");
        }
    }
}
