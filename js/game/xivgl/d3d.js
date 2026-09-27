// D3D11 管線狀態描述（ShaderProbe 擷取的 states）→ WebGL2。列舉值對照 d3d11.h。
// 慣例（配合 tools/dxbc2glsl.mjs）：畫面上下顛倒渲染，GL 視窗 y＝D3D 像素 y ⇒ D3D 的「逆時針為正面」＝GL 的順時針。

const COMPARE = (gl) => [null, gl.NEVER, gl.LESS, gl.EQUAL, gl.LEQUAL, gl.GREATER, gl.NOTEQUAL, gl.GEQUAL, gl.ALWAYS];
const STENCIL_OP = (gl) => [null, gl.KEEP, gl.ZERO, gl.REPLACE, gl.INCR, gl.DECR, gl.INVERT, gl.INCR_WRAP, gl.DECR_WRAP];
const BLEND = (gl) => ({
  1: gl.ZERO, 2: gl.ONE, 3: gl.SRC_COLOR, 4: gl.ONE_MINUS_SRC_COLOR, 5: gl.SRC_ALPHA, 6: gl.ONE_MINUS_SRC_ALPHA,
  7: gl.DST_ALPHA, 8: gl.ONE_MINUS_DST_ALPHA, 9: gl.DST_COLOR, 10: gl.ONE_MINUS_DST_COLOR, 11: gl.SRC_ALPHA_SATURATE,
  14: gl.CONSTANT_COLOR, 15: gl.ONE_MINUS_CONSTANT_COLOR,
});
const BLEND_OP = (gl) => [null, gl.FUNC_ADD, gl.FUNC_SUBTRACT, gl.FUNC_REVERSE_SUBTRACT, gl.MIN, gl.MAX];
const ADDRESS = (gl) => [null, gl.REPEAT, gl.MIRRORED_REPEAT, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE, gl.MIRRORED_REPEAT];

/** D3D11_SAMPLER_DESC → WebGL 取樣器物件（MipLODBias 由著色器 uniform 帶，這裡不處理；BORDER 以 CLAMP 近似）。 */
export function createSampler(gl, desc, aniso) {
  const s = gl.createSampler();
  const f = desc.filter;
  const anisotropic = (f & 0x40) !== 0;
  const minLinear = anisotropic || (f & 0x10) !== 0;
  const magLinear = anisotropic || (f & 0x04) !== 0;
  const mipLinear = anisotropic || (f & 0x01) !== 0;
  gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, minLinear ? (mipLinear ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_NEAREST) : (mipLinear ? gl.NEAREST_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST));
  gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, magLinear ? gl.LINEAR : gl.NEAREST);
  const address = ADDRESS(gl);
  gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, address[desc.address[0]]);
  gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, address[desc.address[1]]);
  gl.samplerParameteri(s, gl.TEXTURE_WRAP_R, address[desc.address[2]]);
  gl.samplerParameterf(s, gl.TEXTURE_MIN_LOD, desc.minLod);
  gl.samplerParameterf(s, gl.TEXTURE_MAX_LOD, Math.min(desc.maxLod, 1000));
  if ((f & 0x80) !== 0) {
    gl.samplerParameteri(s, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.samplerParameteri(s, gl.TEXTURE_COMPARE_FUNC, COMPARE(gl)[desc.comparison]);
  }
  if (anisotropic && aniso) gl.samplerParameterf(s, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.max(1, desc.maxAnisotropy));
  return s;
}

/** 深度模板＋光柵化＋混色。blend.targets[i]＝[enable, src, dst, op, srcA, dstA, opA, writeMask]。 */
export function applyState(gl, { depthStencil: ds, stencilRef, rasterizer: rs, blend }, drawBuffersIndexed) {
  if (ds) {
    ds.depth ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST);
    gl.depthFunc(COMPARE(gl)[ds.depthFunc]);
    gl.depthMask(ds.depthWrite === 1);
    if (ds.stencil) {
      gl.enable(gl.STENCIL_TEST);
      const op = STENCIL_OP(gl);
      gl.stencilFuncSeparate(gl.FRONT, COMPARE(gl)[ds.front[3]], stencilRef, ds.readMask);
      gl.stencilFuncSeparate(gl.BACK, COMPARE(gl)[ds.back[3]], stencilRef, ds.readMask);
      gl.stencilOpSeparate(gl.FRONT, op[ds.front[0]], op[ds.front[1]], op[ds.front[2]]);
      gl.stencilOpSeparate(gl.BACK, op[ds.back[0]], op[ds.back[1]], op[ds.back[2]]);
      gl.stencilMask(ds.writeMask);
    } else gl.disable(gl.STENCIL_TEST);
  }
  if (rs) {
    if (rs.cull === 1) gl.disable(gl.CULL_FACE);
    else { gl.enable(gl.CULL_FACE); gl.cullFace(rs.cull === 2 ? gl.FRONT : gl.BACK); }
    gl.frontFace(rs.frontCCW ? gl.CW : gl.CCW);
    // 陰影貼圖的深度偏移：D3D bias＝DepthBias·r＋SlopeScaled·maxSlope（r＝深度格式最小解析度）＝GL polygonOffset(slope, units)；DepthBiasClamp WebGL 無對應
    if (rs.depthBias || rs.slopeScaledDepthBias) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(rs.slopeScaledDepthBias, rs.depthBias); }
    else gl.disable(gl.POLYGON_OFFSET_FILL);
  }
  if (blend) {
    const factor = BLEND(gl), op = BLEND_OP(gl);
    blend.targets.forEach((t, i) => {
      if (!drawBuffersIndexed) { if (i > 0) return; }
      const [enable, src, dst, bop, srcA, dstA, bopA, mask] = t;
      if (drawBuffersIndexed) {
        enable ? drawBuffersIndexed.enableiOES(gl.BLEND, i) : drawBuffersIndexed.disableiOES(gl.BLEND, i);
        drawBuffersIndexed.blendFuncSeparateiOES(i, factor[src], factor[dst], factor[srcA], factor[dstA]);
        drawBuffersIndexed.blendEquationSeparateiOES(i, op[bop], op[bopA]);
        drawBuffersIndexed.colorMaskiOES(i, !!(mask & 1), !!(mask & 2), !!(mask & 4), !!(mask & 8));
      } else {
        enable ? gl.enable(gl.BLEND) : gl.disable(gl.BLEND);
        gl.blendFuncSeparate(factor[src], factor[dst], factor[srcA], factor[dstA]);
        gl.blendEquationSeparate(op[bop], op[bopA]);
        gl.colorMask(!!(mask & 1), !!(mask & 2), !!(mask & 4), !!(mask & 8));
      }
    });
  }
}
