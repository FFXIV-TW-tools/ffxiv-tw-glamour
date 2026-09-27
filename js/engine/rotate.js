// 外觀預覽測試版：角色繞世界垂直軸（過 pivot）轉 θ，燈光與鏡頭不動（同美容師畫面拖曳轉角色）。
// 遊戲的骨架矩陣把模型座標轉到「主畫面視空間」，所有 pass 共用同一份（陰影 pass 的 VS 用 m_MainViewToProjectionMatrix 投影；
// 2026-09-26 驗證：各 pass 相機的 m_MainViewToWorldMatrix 都等於主畫面 inverse view，同一骨頭各 pass 的矩陣逐位元相同），所以
//   M = W⁻¹ · T(p) · Ry(θ) · T(−p) · W（W＝m_MainViewToWorldMatrix），骨架矩陣 J' = M · J；接縫頂點（主畫面視空間）點用 M、法線用 M 的 3×3。
// 世界空間的方向量（g_InstanceParameter.m_HeadUpVector）只轉 Ry(θ)。

/** cbuffer 內 row_major float3x4（3 列 × 4 float）→ 4×4（第 4 列 0 0 0 1），列優先 */
function mat34(f, floatOffset) {
  const m = new Float64Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) m[r * 4 + c] = f[floatOffset + r * 4 + c];
  m[15] = 1;
  return m;
}

function mul(a, b) {
  const o = new Float64Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]; o[r * 4 + c] = s; }
  return o;
}

function rotY(theta, pivot) {
  const c = Math.cos(theta), s = Math.sin(theta), [px, , pz] = pivot;
  // T(p)·Ry·T(−p)
  return Float64Array.from([c, 0, s, px - c * px - s * pz, 0, 1, 0, 0, -s, 0, c, pz + s * px - c * pz, 0, 0, 0, 1]);
}

/** 仿射 4×4（第 4 列 0 0 0 1）的反矩陣 */
function inverseAffine(m) {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const r = [(e * i - f * h), -(b * i - c * h), (b * f - c * e), -(d * i - f * g), (a * i - c * g), -(a * f - c * d), (d * h - e * g), -(a * h - b * g), (a * e - b * d)].map(v => v / det);
  const t = [m[3], m[7], m[11]];
  const o = new Float64Array(16);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) o[row * 4 + col] = r[row * 3 + col];
    o[row * 4 + 3] = -(r[row * 3] * t[0] + r[row * 3 + 1] * t[1] + r[row * 3 + 2] * t[2]);
  }
  o[15] = 1;
  return o;
}

/** 主畫面視空間的轉動矩陣；camera＝任一筆角色繪圖 VS 的 g_CameraParameter 內容（Float32Array），mainToWorld＝m_MainViewToWorldMatrix 的位元組位移 */
export function viewRotation(camera, mainToWorldOffset, pivot, theta) {
  const W = mat34(camera, mainToWorldOffset / 4);
  return mul(mul(inverseAffine(W), rotY(theta, pivot)), W);
}

/** 骨架矩陣陣列（row_major float3x4 × N）左乘 M */
export function rotateJoints(bytes, M) {
  const src = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const out = new Float32Array(src.length);
  for (let j = 0; j + 12 <= src.length; j += 12) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
      let s = M[r * 4 + 3] * (c === 3 ? 1 : 0);
      for (let k = 0; k < 3; k++) s += M[r * 4 + k] * src[j + k * 4 + c];
      out[j + r * 4 + c] = s;
    }
  }
  return new Uint8Array(out.buffer);
}

/** cbuffer 內某個 float3（世界方向）繞 Y 轉 θ */
export function rotateDirectionAt(bytes, byteOffset, theta) {
  const out = bytes.slice();
  const f = new Float32Array(out.buffer, byteOffset, 3);
  const c = Math.cos(theta), s = Math.sin(theta), x = f[0], z = f[2];
  f[0] = c * x + s * z;
  f[2] = -s * x + c * z;
  return out;
}

/** g_InputConnectionVertex（float4 元素）：元素 0 的 xyz 與奇數元素＝點，2 以上的偶數元素＝法線 */
export function rotateConnection(bytes, M) {
  const out = new Float32Array(Uint8Array.from(bytes).buffer);
  const n = out.length / 4;
  for (let e = 0; e < n; e++) {
    const point = e === 0 || e % 2 === 1;
    const o = e * 4, x = out[o], y = out[o + 1], z = out[o + 2];
    for (let r = 0; r < 3; r++) out[o + r] = M[r * 4] * x + M[r * 4 + 1] * y + M[r * 4 + 2] * z + (point ? M[r * 4 + 3] : 0);
  }
  return new Uint8Array(out.buffer);
}
