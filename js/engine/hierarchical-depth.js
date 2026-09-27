// CreateHierarchicalZ：原 compute 翻譯的 group 模擬需每個 fragment 重跑整組 64 執行緒再散佈 4 次。
// 這筆 dispatch 實際只對深度每個 2／4／8／16 方塊各取 max、min，直接寫各 mip，省掉 group 日誌與散佈。
import { compileProgram } from '../game/xivgl/pass.js';
import { XIV_RTZ16 } from './storage-layout.js';

const VS = `#version 300 es
void main() { gl_Position = vec4(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID >> 1) * 4 - 1), 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_depth;
uniform int u_footprint;
layout(location = 0) out vec4 o;
${XIV_RTZ16}
void main() {
  ivec2 origin = ivec2(gl_FragCoord.xy) * u_footprint;
  float hi = 0.0, lo = 1.0;
  for (int y = 0; y < u_footprint; y++) {
    for (int x = 0; x < u_footprint; x++) {
      float depth = texelFetch(u_depth, origin + ivec2(x, y), 0).r;
      hi = max(hi, depth);
      lo = min(lo, depth);
    }
  }
  o = xiv_rtz16(vec4(hi, lo, 0.0, 0.0));
}`;

/** 只接管已驗證的 2:1 深度 → 四層 RG16F、每層皆完整涵蓋的 dispatch；不符就走通用 group 模擬。 */
export function hierarchicalDepth(r, op, plainState) {
  const gl = r.gl, src = r.tex[op.srvs?.[0]?.res], dst = r.tex[op.uavs?.[0]?.res];
  if (op.cs !== 'compute-CreateHierarchicalZ' || op.srvs?.length !== 1 || op.uavs?.length !== 4 ||
      !src?.depth || src.layers !== 1 || dst?.internal !== 'RG16F' || dst.layers !== 1 || dst.mips !== 4 ||
      src.w !== 2 * dst.w || src.h !== 2 * dst.h ||
      op.threadGroups?.[0] * 8 !== dst.w || op.threadGroups?.[1] * 8 !== dst.h || op.threadGroups?.[2] !== 1 ||
      !op.uavs.every((u, mip) => u.res === op.uavs[0].res && u.mip === mip && u.slice === 0)) return false;
  if (!r._hizProgram) {
    r._hizProgram = compileProgram(gl, VS, FS);
    // 編譯進度原本列通用 compute 與散佈；此實作一支 shader 完成相同的四層輸出。
    r.noteCompile?.('cs:compute-CreateHierarchicalZ');
    r.noteCompile?.('scatter:float');
  }
  plainState(r);
  gl.useProgram(r._hizProgram);
  r.fullRange(src);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, src.tex);
  gl.bindSampler(0, r.nearest);
  gl.uniform1i(r.loc(r._hizProgram, 'u_depth'), 0);
  r._emptyVao ??= gl.createVertexArray();
  gl.bindVertexArray(r._emptyVao);
  for (let mip = 0; mip < 4; mip++) {
    r.fbo([{ res: op.uavs[0].res, mip, slice: 0 }], null);
    gl.viewport(0, 0, dst.w >> mip, dst.h >> mip);
    gl.uniform1i(r.loc(r._hizProgram, 'u_footprint'), 2 << mip);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.bindVertexArray(null);
  gl.bindSampler(0, null);
  return true;
}
