// 著色器翻譯器與 WebGL 重播共用：結構化緩衝貼圖寬度，以及 typed UAV float16 向零截斷。
export const SB_WIDTH = 4096;

// D3D11（遊戲機 NVIDIA）compute 的 typed UAV 寫入 float32→float16 是「向零截斷」：第 14 版海岸 CreateHierarchicalZ
// 以 D24 深度逐值重算，1,843,200 個值向零截斷全吻合、就近捨入只吻合 1,221,257 個。GL 轉換是就近捨入 ⇒ 寫 float16 目標前先截斷。
// 正規數：清掉低 13 位尾數；半精度次正規（|v|<2^-14）：取 2^-24 的整數倍（向零）；Inf／NaN 與超出半精度範圍者不動。
export const XIV_RTZ16 = /* glsl */ `
float xiv_rtz16(float v) {
  uint u = floatBitsToUint(v), e = (u >> 23) & 255u;
  if (e >= 113u) return e > 142u ? v : uintBitsToFloat(u & 0xFFFFE000u);
  float q = floor(abs(v) * 16777216.0) / 16777216.0;
  return v < 0.0 ? -q : q;
}
vec4 xiv_rtz16(vec4 v) { return vec4(xiv_rtz16(v.x), xiv_rtz16(v.y), xiv_rtz16(v.z), xiv_rtz16(v.w)); }`;
