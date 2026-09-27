// 外觀預覽測試版・種族：載入別的種族（或同種族但身高／胸圍不同）的外貌時，整個角色的骨架矩陣與畫面取景（js/engine/equip.js 用）。
// 資料：data/race-pose/<模型碼>.json（tools/race-pose.mjs：18 個模型種族在角色製作畫面的世界空間蒙皮矩陣 W＝S·Model·inv(RefModel)，角色站世界原點）。
// 公式（J＝重播用的主畫面視空間原生矩陣，row-major 3×4）：
//   J[b] = V · H · W[b] · B[b]
//   V＝inverse(m_MainViewToWorldMatrix)＝背景包主畫面的視矩陣（tools/pose-bones.mjs 同一個 V）。
//   H＝對世界原點等比縮放 k＝cmp.height(存檔身高) ÷ 骨架縮放（race-pose skeleton[7]）。S＝Skeleton.Transform 在傾印裡只有縮放
//     （18 份 skeleton[0..6]＝0,0,0,0,0,0,1：不平移、不旋轉），所以把 S 換成 S' 等於整個 W 左乘 S'·S⁻¹＝k·I。
//     驗證（2026-09-26）：美容師擷取的 c0801（身高 0 → 0.96）世界骨架 vs race-pose c0801（身高 50 → 1.00）× k：
//     n_root、j_asi_e_l、j_asi_e_r 平移差 0.000 m（腳底、原點一致；上半身差 ≤ 6 cm 是兩個畫面的待機動作不同）。
//   B＝胸圍，只作用在 j_mune_l/r（18 份傾印這兩根都沒有子骨）。hkQsTransform 的 model＝parent∘local：縮放逐分量相乘、
//     平移與旋轉不受 local 縮放影響 ⇒ local 縮放改成 r 倍時 Model'[m]＝Model[m]·diag(r)
//     ⇒ W'[m]＝S·Model[m]·diag(r)·inv(Ref[m])＝W[m] · (Ref[m]·diag(r)·inv(Ref[m]))，r＝cmp 胸(存檔) ÷ cmp 胸(race-pose 外貌)，逐分量；
//     Ref＝主骨架 sklb 參考姿勢的模型空間（js/game/sklb.js referenceModel）。男性 cmp 胸不作用（customize.js parseCmp.bust）。
// 同種族只換身高／胸圍時 W 用擷取角色自己的姿勢：W＝inv(V)·J_擷取（保留美容師的待機姿勢，同一條公式）。
import { mul34 } from './pbd.js';
import { inverse34 } from './sklb.js';

export const RACE_POSE_BASE = new URL('../../data/race-pose/', import.meta.url).href;
const MUNE = ['j_mune_l', 'j_mune_r'];

/**
 * @param world 骨名 → 12 float 世界空間蒙皮矩陣 W
 * @param V 12 float 主畫面視矩陣；@param k 身高比例；@param bust null 或 { ratio:[x,y,z], ref:(骨名) → RefModel 3×4 }
 * @returns 骨名 → 12 float 主畫面視空間原生矩陣
 */
export function bodyJoints(world, V, k, bust) {
  const out = {};
  const B = bust && Object.fromEntries(MUNE.map(b => {
    const R = bust.ref(b);
    if (!R) throw new Error(`主骨架沒有 ${b}，胸圍無法套用`);
    const Q = Float64Array.from([bust.ratio[0], 0, 0, 0, 0, bust.ratio[1], 0, 0, 0, 0, bust.ratio[2], 0]);
    return [b, mul34(mul34(R, Q), inverse34(R))];
  }));
  for (const [b, w] of Object.entries(world)) {
    let m = Float64Array.from(w, v => v * k);
    if (B?.[b]) m = mul34(m, B[b]);
    out[b] = Array.from(mul34(V, m));
  }
  return out;
}

/** 視空間原生矩陣 → 世界空間（inv(V)·J＝mainToWorld·J） */
export function toWorld(joints, mainToWorld) {
  return Object.fromEntries(Object.entries(joints).map(([b, m]) => [b, Array.from(mul34(mainToWorld, Float64Array.from(m)))]));
}

/**
 * 角色取景（同 tools/game-mode.mjs 第 6 步）：轉軸＝世界水平範圍中心；畫面範圍＝以轉軸為中心、最大水平半徑的圓柱，
 * 高度 41 段取樣投到主畫面（任何轉角都包得住），只算畫面內的高度。
 * @param b { minX, maxX, minY, maxY, minZ, maxZ }（世界）；@param C 相機常數緩衝 float；@param vp m_ViewProjectionMatrix 的 float 位移
 */
export function framing(b, C, vp) {
  const pivot = [(b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2];
  const R = Math.hypot(Math.max(pivot[0] - b.minX, b.maxX - pivot[0]), Math.max(pivot[2] - b.minZ, b.maxZ - pivot[2]));
  const screen = [1, 1, 0, 0];
  for (let k = 0; k <= 40; k++) {
    const y = b.minY + (b.maxY - b.minY) * k / 40;
    for (const x of [pivot[0] - R, pivot[0] + R]) for (const z of [pivot[2] - R, pivot[2] + R]) {
      const clip = [0, 1, 2, 3].map(r => C[vp + r * 4] * x + C[vp + r * 4 + 1] * y + C[vp + r * 4 + 2] * z + C[vp + r * 4 + 3]);
      const u = (clip[0] / clip[3] + 1) / 2, v = (1 - clip[1] / clip[3]) / 2;
      if (clip[3] <= 0 || v < 0 || v > 1) continue;
      screen[0] = Math.min(screen[0], u); screen[1] = Math.min(screen[1], v); screen[2] = Math.max(screen[2], u); screen[3] = Math.max(screen[3], v);
    }
  }
  for (let k = 0; k < 4; k++) screen[k] = Math.min(1, Math.max(0, screen[k]));
  return { pivot, screen };
}

/** 網格（js/game/mdl.js）以骨架矩陣（依網格骨骼表排的 Float32Array）蒙皮、每 7 個頂點取 1 個，轉世界後擴大範圍 b */
export function extendBounds(b, mesh, joints, mainToWorld) {
  const { weights, indices, width } = mesh.blend;
  if (!weights || !indices) return;
  const p = mesh.position, M = mainToWorld;
  for (let v = 0; v < p.length / 3; v += 7) {
    const out = [0, 0, 0];
    for (let k = 0; k < width; k++) {
      const w = weights[v * width + k] / 255, j = indices[v * width + k] * 12;
      if (!w || j + 12 > joints.length) continue;
      for (let r = 0; r < 3; r++) out[r] += w * (joints[j + r * 4] * p[v * 3] + joints[j + r * 4 + 1] * p[v * 3 + 1] + joints[j + r * 4 + 2] * p[v * 3 + 2] + joints[j + r * 4 + 3]);
    }
    const x = M[0] * out[0] + M[1] * out[1] + M[2] * out[2] + M[3];
    const y = M[4] * out[0] + M[5] * out[1] + M[6] * out[2] + M[7];
    const z = M[8] * out[0] + M[9] * out[1] + M[10] * out[2] + M[11];
    b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
    b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z);
  }
}

export const emptyBounds = () => ({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity });
