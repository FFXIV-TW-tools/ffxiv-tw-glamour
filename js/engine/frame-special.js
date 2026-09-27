// 開發用（重播）：以網頁內建著色器執行、行為已由快照驗證的等效操作，以及把結果顯示到頁面 canvas。
// - depthCopy（tools/depth-copy-id.mjs 驗證）：SV_Depth＝t0 在目標像素中心 uv 的雙線性取樣；深度貼圖不可線性過濾 → 手動四點。
// - constFill（tools/game-mode.mjs 驗證）：每個目標寫入頂點色（同一筆繪圖的深度模板狀態決定哪些像素）。
import { compileProgram } from '../game/xivgl/pass.js';
import { applyState } from '../game/xivgl/d3d.js';

const FULLSCREEN_VS = `#version 300 es
void main() { gl_Position = vec4(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID >> 1) * 4 - 1), 0.0, 1.0); }`;
const DEPTH_COPY_FS = `#version 300 es
precision highp float;
uniform highp sampler2D u_src;
uniform vec4 u_vp;
out vec4 o;
float at(ivec2 p, ivec2 n) { return texelFetch(u_src, clamp(p, ivec2(0), n - 1), 0).r; }
void main() {
  ivec2 n = textureSize(u_src, 0);
  vec2 p = (gl_FragCoord.xy - u_vp.xy) / u_vp.zw * vec2(n) - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - floor(p);
  float top = mix(at(i, n), at(i + ivec2(1, 0), n), f.x);
  float bottom = mix(at(i + ivec2(0, 1), n), at(i + ivec2(1, 1), n), f.x);
  gl_FragDepth = mix(top, bottom, f.y);
  o = vec4(0.0);
}`;
const FILL_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
${[0, 1, 2, 3, 4, 5, 6, 7].map(k => `layout(location = ${k}) out vec4 o${k};`).join('\n')}
void main() { ${[0, 1, 2, 3, 4, 5, 6, 7].map(k => `o${k} = u_color;`).join(' ')} }`;
const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec4 u_rect;   // 來源 uv 範圍（D3D 由上而下）
uniform vec2 u_size;   // canvas 像素
uniform bool u_transient; // 平移／縮放超出上一張裁切畫面的範圍時顯示中性底色，避免邊緣像素被拉成條紋
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec2 st = mix(u_rect.xy, u_rect.zw, vec2(uv.x, 1.0 - uv.y));
  if (u_transient && (st.x < 0.0 || st.x > 1.0 || st.y < 0.0 || st.y > 1.0)) { o = vec4(0.035, 0.045, 0.055, 1.0); return; }
  o = vec4(texture(u_src, st).rgb, 1.0);
}`;

function fullscreen(r) {
  const gl = r.gl;
  r._emptyVao ??= gl.createVertexArray();
  gl.bindVertexArray(r._emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}

export function depthCopy(r, op) {
  const gl = r.gl;
  if (!r._copyProg) { r._copyProg = compileProgram(gl, FULLSCREEN_VS, DEPTH_COPY_FS); r.noteCompile?.('special:depthCopy'); }
  const srv = op.srvs[0];
  const src = srv.res === op.dsv.res ? r.readableCopy(srv.res, 0, 1) : r.tex[srv.res];
  r.fbo([], op.dsv);
  r.viewportAndDepth(op.viewport);
  applyState(gl, { depthStencil: op.state.depthStencil, stencilRef: op.state.stencilRef, rasterizer: { ...op.state.rasterizer, cull: 1 } }, r.ext.dbi);
  gl.useProgram(r._copyProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(src.target, src.tex);
  gl.bindSampler(0, r.nearest);
  gl.uniform1i(gl.getUniformLocation(r._copyProg, 'u_src'), 0);
  gl.uniform4f(gl.getUniformLocation(r._copyProg, 'u_vp'), ...op.viewport.slice(0, 4));
  fullscreen(r);
  gl.bindSampler(0, null);
}

export function constFill(r, op) {
  const gl = r.gl;
  if (!r._fillProg) { r._fillProg = compileProgram(gl, FULLSCREEN_VS, FILL_FS); r.noteCompile?.('special:constFill'); }
  const ds = op.state.depthStencil;
  const dsv = op.dsv && (ds?.depth || ds?.stencil) ? op.dsv : null;
  r.fbo(op.rtvs.reduce((a, v) => { a[v.slot] = v; return a; }, []), dsv);
  r.viewportAndDepth(op.viewport);
  applyState(gl, { ...op.state, rasterizer: { ...op.state.rasterizer, cull: 1 } }, r.ext.dbi);
  if (!dsv) { gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); }
  gl.useProgram(r._fillProg);
  gl.uniform4fv(gl.getUniformLocation(r._fillProg, 'u_color'), op.color);
  fullscreen(r);
}

/** 資源 key 的內容畫到頁面 canvas；rect＝來源範圍（0..1，D3D 左上起）供縮放 */
export function present(r, key, rect = [0, 0, 1, 1]) {
  const gl = r.gl;
  const t = r.tex[key];
  if (!r._presentProg) { r._presentProg = compileProgram(gl, FULLSCREEN_VS, PRESENT_FS); r.noteCompile?.('special:present'); }
  if (!r._linear) {
    r._linear = gl.createSampler();
    gl.samplerParameteri(r._linear, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(r._linear, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(r._linear, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(r._linear, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.depthRange(0, 1);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);
  if (r.ext.dbi) { r.ext.dbi.disableiOES(gl.BLEND, 0); r.ext.dbi.colorMaskiOES(0, true, true, true, true); }
  gl.useProgram(r._presentProg);
  r.fullRange(t);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  gl.bindSampler(0, r._linear);
  gl.uniform1i(gl.getUniformLocation(r._presentProg, 'u_src'), 0);
  gl.uniform4fv(gl.getUniformLocation(r._presentProg, 'u_rect'), rect);
  gl.uniform2f(gl.getUniformLocation(r._presentProg, 'u_size'), gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.uniform1i(gl.getUniformLocation(r._presentProg, 'u_transient'), rect[0] !== 0 || rect[1] !== 0 || rect[2] !== 1 || rect[3] !== 1 ? 1 : 0);
  fullscreen(r);
  gl.bindSampler(0, null);
}
