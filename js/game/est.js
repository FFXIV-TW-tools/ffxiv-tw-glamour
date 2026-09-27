// 額外骨架表（.est）：裝備／髮型／臉型 id × 種族性別 → 額外骨架編號（頭飾 j_ex_met_*、上衣 j_ex_top_*、髮型 j_ex_h*）。
// 版面（台服 client 實測；同 Penumbra Meta/Files/EstFile.cs）：u32 筆數；筆數 ×（u16 set、u16 種族性別碼）；再筆數 × u16 骨架編號。
//   set＝met／top 的裝備 id、hair／face 的髮型／臉型 id；骨架編號不一定等於 set（髮型例：c0101 set 1→3、13→102）。
// 骨架路徑照 Penumbra.GameData GamePaths.Sklb.Customization＋EstTypeExtensions.ToSuffix（Head→met、Body→top、Hair→hair、Face→face）：
//   chara/human/c{種族}/skeleton/{kind}/{kind[0]}{骨架編號:D4}/skl_c{種族}{kind[0]}{骨架編號:D4}.sklb。
//   種族：Penumbra ModelManager.ResolveSklbsForMdl 用 mdl 路徑上的種族 ⇒ met／top 要用「裝備模型實際用的種族」
//   （paths.js resolveGear(...).code，含替代鏈），不是角色種族——2026-09-26 傾印驗證：c0401 角色的頭飾骨架逐值等於 skl_c0201m0370。
//   hair／face 用角色種族（傾印 32 角色逐值對上）。
//   表裡沒有這筆（或編號 0）＝沒有額外骨架（Penumbra：EstEntry.Zero → 不載）。全種族四張表有 160 筆指向 sqpack 不存在的 sklb
//   （髮型 112 筆幾乎都是 h0001，例 c0801 set 162；另 met 21、top 25、face 2），遊戲大概就是不載（未驗證）；呼叫端請再用 sqpack has() 確認。
// 2026-09-26 tmp/verify-sklb.mjs：c0801 met 493／top 27／face 18 筆路徑全存在、hair 110 筆有 109 筆存在（缺 h0001）。
import { qs34, inverse34 } from './sklb.js';
import { mul34 } from './pbd.js';

export const EST_PATHS = {
  met: 'chara/xls/charadb/extra_met.est',
  top: 'chara/xls/charadb/extra_top.est',
  hair: 'chara/xls/charadb/hairskeletontemplate.est',
  face: 'chara/xls/charadb/faceskeletontemplate.est',
};

/** .est → Map（種族性別碼 → Map（set → 骨架編號）） */
export function parseEst(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0, true);
  const ids = 4 + n * 4;
  const out = new Map();
  for (let i = 0; i < n; i++) {
    const set = dv.getUint16(4 + i * 4, true), genderRace = dv.getUint16(6 + i * 4, true);
    if (!out.has(genderRace)) out.set(genderRace, new Map());
    out.get(genderRace).set(set, dv.getUint16(ids + i * 2, true));
  }
  return out;
}

/** 額外骨架編號 → sklb 路徑（kind 同 EST_PATHS 的鍵；raceCode 801 或 '0801'） */
export function sklbPath(kind, raceCode, skeletonId) {
  if (!(kind in EST_PATHS)) throw new Error(`未知的額外骨架種類 ${kind}`);
  const c = String(Number(raceCode)).padStart(4, '0'), s = `${kind[0]}${String(skeletonId).padStart(4, '0')}`;
  return `chara/human/c${c}/skeleton/${kind}/${s}/skl_c${c}${s}.sklb`;
}

/** 主骨架（base）sklb 路徑 */
export const baseSklbPath = (raceCode) => { const c = String(Number(raceCode)).padStart(4, '0'); return `chara/human/c${c}/skeleton/base/b0001/skl_c${c}b0001.sklb`; };

/**
 * @param kind 'met'｜'top'｜'hair'｜'face'；@param set 裝備 id（met/top）或髮型／臉型 id；@param raceCode 種族性別碼（801 或 '0801'）
 * @param est parseEst(EST_PATHS[kind]) 的結果
 * @returns sklb 路徑，或 null（這個組合沒有額外骨架）
 */
export function extraSkeletonPath(kind, set, raceCode, est) {
  const id = est.get(Number(raceCode))?.get(Number(set));
  return id ? sklbPath(kind, raceCode, id) : null;
}

/**
 * 額外骨架剛性接到主骨架 → 額外骨頭的原生蒙皮矩陣（沒有姿勢資料時用：換裝／外貌換上擷取角色沒戴的額外骨架）。
 * 推導（tools/pose-bones.mjs）：J[b] = V·S·A·Model_p[b]·inv(RefModel_p[b])，A＝Model0[P]·inv(Model_p[根])（P＝根骨接的主骨架骨）。
 *   剛性假設＝額外骨架停在參考姿勢：Model_p[b]＝RefModel_p[b] ⇒ Model_p[b]·inv(RefModel_p[b])＝I，且 A·Model_p[根]＝Model0[P]，
 *   ⇒ J[b]＝V·S·Model0[P]·inv(RefModel_p[根])；主骨架原生矩陣 J0[P]＝V·S·Model0[P]·inv(RefModel0[P]) ⇒ V·S·Model0[P]＝J0[P]·RefModel0[P]，
 *   ⇒ J[b]＝J0[P] · RefModel0[P] · inv(RefModel_p[根])——同一根骨底下所有骨頭同一個矩陣。
 * 根骨接點：主骨架有同名骨就接同名骨（頭飾／髮型根骨 j_kao、多數上衣根骨），否則用檔頭 connect（t0100 系 n_ex_top → j_sebo_c）；
 *   都沒有就丟錯。多根骨架（例 t0377 j_ude_b_l／j_ude_b_r）各根各自接同名骨——姿勢傾印只記一組接點，多根的接法未驗證。
 * 驗證（tmp/verify-est-rigid.mjs，2026-09-26）：
 *   頭飾：第 10 版 5 次擷取（各 16 份姿勢傾印）共 155 個（擷取×角色）、2480 個 met 骨架，剛性 vs 傾印公式元素最大差 2.9e-6、旋轉 0.0002°（剛性成立）；
 *   上衣：capture-20260926-092611 可見角色 e0100（t0100，根骨 n_ex_top 經檔頭接 j_sebo_c），GPU g_JointMatrixArray 4 個常數緩衝的
 *     9 根 j_ex_top_* 對剛性公式元素最大差 1.2e-6、旋轉 0.0001°；
 *   髮型：同 5 次擷取 160 個（擷取×角色）、2560 個 hair 骨架，最大平移差 0.51、旋轉 26.2°（物理擺動，例 j_ex_h0106_ke_f_b）——剛性只是靜止姿勢。
 * @param partial parseSklb(額外骨架)；@param main parseSklb(主骨架 base)；@param mainRef sklb.js referenceModel(main)
 * @param native (骨名) → 主骨架該骨原生矩陣（row-major 3×4），沒有＝undefined
 * @returns Map（只在額外骨架、不在主骨架的骨名 → Float64Array(12)）
 */
export function rigidExtraJoints(partial, main, mainRef, native) {
  const mainIndex = new Map(main.bones.map((b, i) => [b, i]));
  const rootOf = (b) => { while (partial.parents[b] >= 0) b = partial.parents[b]; return b; };
  const attach = new Map();
  const out = new Map();
  partial.bones.forEach((name, b) => {
    if (mainIndex.has(name)) return; // 主骨架也有的骨（接點本身）用主骨架的
    const r = rootOf(b);
    if (!attach.has(r)) {
      const P = mainIndex.get(partial.bones[r]) ?? (r === 0 ? partial.connect : null);
      if (P == null || P >= main.bones.length) throw new Error(`額外骨架根骨 ${partial.bones[r]} 在主骨架找不到接點`);
      const J0 = native(main.bones[P]);
      if (!J0) throw new Error(`額外骨架接點 ${main.bones[P]} 沒有姿勢`);
      attach.set(r, mul34(mul34(Float64Array.from(J0), mainRef[P]), inverse34(qs34(partial.reference, r * 10))));
    }
    out.set(name, attach.get(r));
  });
  return out;
}
