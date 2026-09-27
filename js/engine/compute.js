// 開發用（完整一幀・compute）：重播 dispatch op。WebGL2 沒有 compute ⇒ tools/dxbc2glsl.mjs 把遊戲的 cs_5_0 翻成 fragment shader
// （manifest.shaders[op.cs]，info.stage＝'cs'），這裡依 info.mode 執行：
//  direct：一個 fragment＝一個執行緒（gl_FragCoord.xy＝DTid.xy，uniform xiv_layer＝DTid.z）。RT＝唯一被寫的 UAV 的 view（mip／slice），
//    視埠＝UAV 尺寸 ∩ 執行緒格（D3D 越界寫入丟棄；沒被執行緒涵蓋的 texel 保持原內容）。3D／陣列 UAV 逐層畫。沒寫到自己的 fragment
//    discard（＝D3D 不寫就不變）。
//  group：一個 fragment＝一個執行緒，fragment 內循序模擬整個 group（groupshared、屏障），把自己每個 store 指令的
//    （值位元, 位址）寫進 MRT 記錄貼圖（RGBA32UI），再逐 store 指令以點（gl_POINTS，一個執行緒一點）散佈到該 UAV 的 view。
// 規則依據：每支啟用的 CS 以 tools/build-compute-check.mjs＋ComputeCheck（本檔）用擷取的 UAV before 快照當起點跑一次，
// 與 after 快照逐值比對（結果 tmp/replay/compute-check/<擷取>/results.json）。
// 同一資源同時是 SRV 與 UAV：SRV 先複製（FrameReplay.readableCopy），讀到的是執行前內容。
import { compileProgram } from '../game/xivgl/pass.js';
import { nullTexture, decodeSnapshot, subresourceList } from './textures.js';
import { SB_WIDTH, XIV_RTZ16 } from './storage-layout.js';
import { hierarchicalDepth } from './hierarchical-depth.js';

const shaderDecoder = new TextDecoder();

// 全螢幕三角形（不需頂點屬性）
const FULL_VS = `#version 300 es
void main() { gl_Position = vec4(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID >> 1) * 4 - 1), 0.0, 1.0); }`;

// group 模式散佈：第 i 個點＝記錄貼圖第 i 個 texel（＝第 i 個執行緒）；無效或越界的點丟到裁切範圍外。
// 目標 texel (x, y) 的中心 NDC＝(x+0.5)/w·2−1（GL 第 0 列＝D3D 最上列，與 direct 模式的 gl_FragCoord 慣例一致）
const SCATTER_VS = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D xiv_val, xiv_addr;
uniform int xiv_w;
uniform uvec3 xiv_size;
flat out uvec4 v_val;
void main() {
  ivec2 p = ivec2(gl_VertexID % xiv_w, gl_VertexID / xiv_w);
  uvec4 a = texelFetch(xiv_addr, p, 0);
  v_val = texelFetch(xiv_val, p, 0);
  gl_PointSize = 1.0;
  if (a.w == 0u || a.x >= xiv_size.x || a.y >= xiv_size.y) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  else gl_Position = vec4((vec2(a.xy) + 0.5) / vec2(xiv_size.xy) * 2.0 - 1.0, 0.0, 1.0);
}`;
// float：目標是 float16 時照 D3D 向零截斷（XIV_RTZ16 註解）
const SCATTER_FS = {
  float: `uniform bool xiv_half;${XIV_RTZ16}\nlayout(location = 0) out vec4 o; void main() { o = xiv_half ? xiv_rtz16(uintBitsToFloat(v_val)) : uintBitsToFloat(v_val); }`,
  uint: 'layout(location = 0) out uvec4 o; void main() { o = v_val; }',
  int: 'layout(location = 0) out ivec4 o; void main() { o = ivec4(v_val); }',
};
const scatterFs = (type) => `#version 300 es\nprecision highp float; precision highp int;\nflat in uvec4 v_val;\n${SCATTER_FS[type]}`;
const HALF = new Set(['RGBA16F', 'RG16F', 'R16F']);
/**
 * 擷取沒有 CS 取樣器狀態（第 14 版插件的 draw 只有 samplers／vs／hs／ds／gsSamplers，dispatch 沒有 csSamplers）時用的狀態：點取樣＋CLAMP。
 * 依據（tools/build-compute-check.mjs 驗證包，5 份擷取）：TscmaaProcessTAACandidatesFullScreen 在 {點, 線性}×{MIRROR, CLAMP} 四種候選下
 * 全部逐值吻合、WRAP 不吻合（海岸 8／荒野 13 個值）；CreateHierarchicalZ 的 gather 只取範圍內 texel 中心，取樣器不影響結果（逐值吻合）。
 * 比較取樣器（sampler*Shadow）沒有狀態就不重播（比較函式無從得知）；VolumeBlur 16 種候選都不吻合，未啟用。
 */
const CS_SAMPLER_DEFAULT = { filter: 0, address: [3, 3, 3], minLod: 0, maxLod: 3.4e38, mipLodBias: 0, comparison: 1, maxAnisotropy: 1 };

/** 翻譯後的 CS（diag：#define XIV_DIAG，direct 模式改輸出「有寫／散佈」旗標，驗證用） */
async function csProgram(r, name, info, diag = false) {
  const key = `cs|${name}|${diag ? 'diag' : ''}`;
  if (r.programs[key]) return r.programs[key];
  let src = shaderDecoder.decode(await r.bytesOf({ file: info.file }));
  if (diag) src = src.replace(/^(#version 300 es)\n/, '$1\n#define XIV_DIAG 1\n');
  const program = compileProgram(r.gl, FULL_VS, src);
  r.programs[key] = program;
  if (!diag) r.noteCompile?.(`cs:${name}`);
  return program;
}

function scatterProgram(r, type) {
  r._csScatter ??= {};
  if (!r._csScatter[type]) {
    r._csScatter[type] = compileProgram(r.gl, SCATTER_VS, scatterFs(type));
    r.noteCompile?.(`scatter:${type}`);
  }
  return r._csScatter[type];
}

/** compute 不走 applyState：混色、深度模板、裁切、剔除全關，寫全部通道 */
function plainState(r) {
  const gl = r.gl;
  for (const cap of [gl.BLEND, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.SCISSOR_TEST, gl.CULL_FACE, gl.POLYGON_OFFSET_FILL, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.RASTERIZER_DISCARD]) gl.disable(cap);
  gl.colorMask(true, true, true, true);
  if (r.ext.dbi) for (let i = 0; i < 8; i++) { r.ext.dbi.disableiOES(gl.BLEND, i); r.ext.dbi.colorMaskiOES(i, true, true, true, true); }
}

/** 整數貼圖（usampler／isampler）沒綁 SRV：1×1 全零 RGBA8UI／RGBA8I */
function nullInteger(r, integer) {
  const gl = r.gl;
  r._csNullInt ??= {};
  if (r._csNullInt[integer]) return r._csNullInt[integer];
  r.scratch();
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, integer === 'uint' ? gl.RGBA8UI : gl.RGBA8I, 1, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, integer === 'uint' ? gl.RGBA_INTEGER : gl.RGBA_INTEGER, integer === 'uint' ? gl.UNSIGNED_BYTE : gl.BYTE, integer === 'uint' ? new Uint8Array(4) : new Int8Array(4));
  return (r._csNullInt[integer] = { tex, target: gl.TEXTURE_2D });
}

/** 常數緩衝與 SRV／取樣器綁定（同 FrameReplay.draw 的規則；階段前綴 cs、區塊 CS_CB#、取樣器表 op.samplers） */
async function bindInputs(r, op, info, program) {
  const gl = r.gl;
  let binding = 0;
  for (const [slot, v] of Object.entries(op.csCbs ?? {})) {
    const index = r.loc(program, `block:CS_CB${slot}`);
    if (index === gl.INVALID_INDEX) continue;
    gl.uniformBlockBinding(program, index, binding);
    const patched = r.cbHook ? await r.cbHook(op, 'CS', Number(slot), v) : null;
    r.bindUbo(binding, patched ?? await r.ubo(v.file, v.size));
    binding++;
  }
  const uavRes = new Set(op.uavs.map(u => u.res));
  let unit = 0;
  for (const b of info.textures) {
    const srv = op.srvs.find(s => s.slot === b.t);
    if (!srv) {
      if (b.integer) {
        const t = nullInteger(r, b.integer);
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(t.target, t.tex);
        gl.bindSampler(unit, r.nearest);
        gl.uniform1i(r.loc(program, b.name), unit++);
      } else r.bindNull(program, b, unit++);
      const levels = r.loc(program, `cs_t${b.t}_levels`);
      if (levels) gl.uniform1i(levels, 1);
      continue;
    }
    let t = r.tex[srv.res];
    if (!t) { r.log.push(`#${op.i} cs t${b.t} 沒有資源 ${srv.res}`); unit++; continue; }
    if (b.type === 'structured' ? !t.structured : t.structured) { r.log.push(`#${op.i} cs t${b.t} 型別不符（${b.type}）`); unit++; continue; }
    const mips = t.structured ? 1 : Math.max(1, Math.min(srv.mips ?? 1, t.mips - (srv.mip ?? 0)));
    if (uavRes.has(srv.res)) t = r.readableCopy(srv.res, srv.mip ?? 0, mips);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(t.target, t.tex);
    if (!t.structured) {
      gl.texParameteri(t.target, gl.TEXTURE_BASE_LEVEL, srv.mip ?? 0);
      gl.texParameteri(t.target, gl.TEXTURE_MAX_LEVEL, (srv.mip ?? 0) + mips - 1);
    }
    gl.bindSampler(unit, b.fetch || t.structured || b.integer ? r.nearest : r.sampler(op.samplers?.[b.sampler] ?? CS_SAMPLER_DEFAULT, t.depth && !b.compare));
    gl.uniform1i(r.loc(program, b.name), unit++);
    const levels = r.loc(program, `cs_t${b.t}_levels`);
    if (levels) gl.uniform1i(levels, mips);
  }
  for (const s of info.samplers ?? []) {
    const loc = r.loc(program, `cs_s${s[0]}_bias`);
    if (loc) gl.uniform1f(loc, op.samplers?.[s[0]]?.mipLodBias ?? 0);
  }
  return unit;
}

/** UAV view 的 mip 尺寸（深度＝3D 該 mip 的切片數；陣列＝view 的層數） */
function viewSize(t, v) {
  const mip = v.mip ?? 0;
  const w = Math.max(1, t.w >> mip), h = Math.max(1, t.h >> mip);
  const d = t.volume ? Math.max(1, t.layers >> mip) : t.layers > 1 ? Math.max(1, v.slices ?? 1) : 1;
  return [w, h, d];
}

/** DispatchIndirect 的群組數：參數緩衝（R32UI 資料貼圖）offset 起 3 個 dword */
function indirectGroups(r, op) {
  const gl = r.gl;
  const t = r.tex[op.indirect.res];
  if (!t?.structured) { r.log.push(`#${op.i} DispatchIndirect 參數緩衝 ${op.indirect.res} 沒有內容，未重播`); return null; }
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
  const out = [];
  for (let k = 0; k < 3; k++) {
    const i = op.indirect.offset / 4 + k;
    const px = new Uint32Array(4);
    gl.readPixels(i % SB_WIDTH, Math.floor(i / SB_WIDTH), 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, px);
    out.push(px[0]);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  return out;
}

/**
 * 執行一筆 dispatch op（FrameReplay.run 呼叫）。diag：只跑 direct 模式的診斷版，回傳 { written, scatter }（執行緒數），不改 UAV。
 */
export async function dispatch(r, op, { diag = false } = {}) {
  const gl = r.gl;
  const info = r.m.shaders[op.cs];
  if (!info || info.stage !== 'cs') { r.log.push(`#${op.i} compute ${op.cs} 沒有翻譯結果，未重播`); return null; }
  const noCompare = info.textures.find(b => b.compare && !op.samplers?.[b.sampler]);
  if (noCompare) { r.log.push(`#${op.i} ${op.cs} ${noCompare.name} 是比較取樣，擷取沒有該取樣器狀態，未重播`); return null; }
  if (!diag && hierarchicalDepth(r, op, plainState)) return null;
  const groups = op.threadGroups ?? indirectGroups(r, op);
  if (!groups) return null;
  if (groups.some(g => g === 0)) return { written: 0, scatter: 0 }; // 0 群組＝不執行
  const [X, Y, Z] = info.threadGroup;
  const threads = [groups[0] * X, groups[1] * Y, groups[2] * Z];
  const program = await csProgram(r, op.cs, info, diag);
  gl.useProgram(program);
  const units = await bindInputs(r, op, info, program);
  plainState(r);
  r._emptyVao ??= gl.createVertexArray();
  gl.bindVertexArray(r._emptyVao);
  let result = null;
  if (info.mode === 'direct') result = runDirect(r, op, info, program, threads, diag);
  else if (diag) throw new Error('diag 只用於 direct 模式');
  else runGroup(r, op, info, program, threads, units);
  gl.bindVertexArray(null);
  for (let u = 0; u < units + 2; u++) gl.bindSampler(u, null);
  return result;
}

function runDirect(r, op, info, program, threads, diag) {
  const gl = r.gl;
  const slot = info.uavs.find(u => u.stored).slot;
  const view = op.uavs.find(u => u.slot === slot);
  if (!view) { r.log.push(`#${op.i} ${op.cs} u${slot} 沒有綁 UAV（寫入丟棄）`); return null; }
  const t = r.tex[view.res];
  if (!t) { r.log.push(`#${op.i} ${op.cs} u${slot} 沒有資源 ${view.res}，未重播`); return null; }
  const [mw, mh, md] = viewSize(t, view);
  const w = Math.min(mw, threads[0]), h = Math.min(mh, threads[1]), d = Math.min(md, threads[2]);
  gl.uniform3ui(r.loc(program, `xiv_u${slot}_size`), mw, mh, md);
  const half = r.loc(program, `xiv_u${slot}_half`);
  if (half) gl.uniform1i(half, HALF.has(t.internal) ? 1 : 0);
  const layerLoc = r.loc(program, 'xiv_layer');
  const stats = { written: 0, scatter: 0 };
  for (let z = 0; z < d; z++) {
    const target = { res: view.res, mip: view.mip ?? 0, slice: (view.slice ?? 0) + z };
    if (diag) diagTarget(r, w, h);
    else r.fbo([target], null);
    gl.viewport(0, 0, w, h);
    gl.uniform1ui(layerLoc, z);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (diag) {
      const px = new Uint32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA_INTEGER, gl.UNSIGNED_INT, px);
      for (let i = 0; i < w * h; i++) { stats.written += px[i * 4]; stats.scatter += px[i * 4 + 1]; }
    }
  }
  return diag ? stats : null;
}

/** 診斷輸出：RGBA32UI 暫存 RT（尺寸變了就重建） */
function diagTarget(r, w, h) {
  const gl = r.gl;
  let d = r._csDiag;
  if (!d || d.w < w || d.h < h) {
    if (d) { gl.deleteTexture(d.tex); gl.deleteFramebuffer(d.fb); }
    r.scratch();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    d = r._csDiag = { tex, fb, w, h };
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, d.fb);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
}

/** 記錄貼圖（每個 store 指令一對 RGBA32UI：值、位址），依執行緒格尺寸快取 */
function logTargets(r, W, H, n) {
  const gl = r.gl;
  r._csLogs ??= new Map();
  const key = `${W}x${H}x${n}`;
  if (r._csLogs.has(key)) return r._csLogs.get(key);
  r.scratch();
  const texs = [];
  for (let k = 0; k < 2 * n; k++) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, W, H);
    texs.push(tex);
  }
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  texs.forEach((tex, k) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, tex, 0));
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`compute 記錄 FBO 不完整 ${status}`);
  const logs = { fb, texs };
  r._csLogs.set(key, logs);
  return logs;
}

function runGroup(r, op, info, program, threads, units) {
  const gl = r.gl;
  if (threads[2] !== 1) { r.log.push(`#${op.i} ${op.cs} group 模式 Z 方向 ${threads[2]} 個執行緒，未支援`); return; }
  const [W, H] = threads;
  const n = info.stores.length;
  if (2 * n > gl.getParameter(gl.MAX_DRAW_BUFFERS)) { r.log.push(`#${op.i} ${op.cs} 需要 ${2 * n} 個 draw buffer，未重播`); return; }
  const logs = logTargets(r, W, H, n);
  gl.bindFramebuffer(gl.FRAMEBUFFER, logs.fb);
  gl.drawBuffers(logs.texs.map((_, k) => gl.COLOR_ATTACHMENT0 + k));
  gl.viewport(0, 0, W, H);
  gl.uniform1ui(r.loc(program, 'xiv_layer'), 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // 散佈：每個 store 指令一次，目標＝該指令的 UAV view
  info.stores.forEach((s, k) => {
    const view = op.uavs.find(u => u.slot === s.uav);
    if (!view) return; // 沒綁 UAV＝寫入丟棄
    const t = r.tex[view.res];
    if (!t) { r.log.push(`#${op.i} ${op.cs} u${s.uav} 沒有資源 ${view.res}`); return; }
    if (t.layers > 1) { r.log.push(`#${op.i} ${op.cs} u${s.uav} 陣列／3D UAV 的 group 模式未支援`); return; }
    const type = info.uavs.find(u => u.slot === s.uav).valueType;
    const sp = scatterProgram(r, type);
    gl.useProgram(sp);
    const [mw, mh] = viewSize(t, view);
    r.fbo([{ res: view.res, mip: view.mip ?? 0, slice: 0 }], null);
    gl.viewport(0, 0, mw, mh);
    for (const [j, name] of [[0, 'xiv_val'], [1, 'xiv_addr']]) {
      gl.activeTexture(gl.TEXTURE0 + units + j);
      gl.bindTexture(gl.TEXTURE_2D, logs.texs[2 * k + j]);
      gl.bindSampler(units + j, r.nearest);
      gl.uniform1i(r.loc(sp, name), units + j);
    }
    gl.uniform1i(r.loc(sp, 'xiv_w'), W);
    gl.uniform3ui(r.loc(sp, 'xiv_size'), mw, mh, 1);
    if (type === 'float') gl.uniform1i(r.loc(sp, 'xiv_half'), HALF.has(t.internal) ? 1 : 0);
    gl.drawArrays(gl.POINTS, 0, W * H);
  });
}

// ---------- 驗證：UAV before 快照當起點跑一次，與 after 快照逐值比 ----------

/** 我方 UAV 的一個子資源（3D 為第 z 片）→ { w, h, px: Float32Array RGBA }；整數格式讀整數值、UNORM 讀 0..1 */
export function readUav(r, key, { mip = 0, layer = 0 } = {}) {
  const gl = r.gl;
  const t = r.tex[key];
  const w = Math.max(1, t.w >> mip), h = Math.max(1, t.h >> mip);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  r.fullRange(t);
  if (t.layers > 1) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t.tex, mip, layer);
  else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, mip);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  let px;
  if (t.internal === 'R8UI') {
    const u = new Uint32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA_INTEGER, gl.UNSIGNED_INT, u);
    px = Float32Array.from(u);
  } else if (t.internal === 'RGBA8' || t.internal === 'R8') {
    const b = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
    px = Float32Array.from(b, v => v / 255);
  } else {
    px = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  return { w, h, px };
}

/** 快照 → 各 (mip, z) 的解碼結果 */
function snapshotPlanes(ref, bytes) {
  const out = [];
  for (const s of subresourceList(ref, ref.w, ref.h)) {
    for (let z = 0; z < (s.d ?? 1); z++) out.push({ mip: s.mip, slice: s.slice, z, ...decodeSnapshot(ref.fmt, bytes, { ...s, offset: s.offset + z * (s.depthPitch ?? 0) }) });
  }
  return out;
}

/** 通道數（只比格式實際有的通道） */
const CHANNELS = { 10: 4, 9: 4, 2: 4, 1: 4, 28: 4, 27: 4, 87: 4, 34: 2, 33: 2, 41: 1, 39: 1, 61: 1, 60: 1, 62: 1 };

/**
 * 驗證包（tools/build-compute-check.mjs）：每筆 dispatch 一個迷你 manifest（resources 以快照初始化、ops＝[該筆 dispatch]）。
 * 用法（瀏覽器）：const c = await ComputeCheck.load('./bundles/compute-check/<擷取>/'); const results = await c.runAll();
 */
export class ComputeCheck {
  static async load(base) {
    const c = new ComputeCheck();
    c.base = base;
    c.FrameReplay = (await import('./frame.js')).FrameReplay; // frame.js 也 import 本檔：執行期再取，避免循環載入時序
    c.m = await (await fetch(base + 'manifest.json', { cache: 'no-store' })).json();
    c.canvas = document.createElement('canvas');
    c.gl = c.canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
    return c;
  }

  async runOne(test) {
    const gl = this.gl;
    const r = new this.FrameReplay({ resources: test.resources, ops: [], shaders: this.m.shaders }, gl);
    r.base = this.base;
    const out = { i: test.i, cs: test.cs, mode: this.m.shaders[test.cs]?.mode, uavs: [] };
    const t0 = performance.now();
    try {
      await r.createResources();
      if (out.mode === 'direct') out.diag = await dispatch(r, test.op, { diag: true });
      await dispatch(r, test.op);
      gl.finish();
      out.ms = Math.round(performance.now() - t0);
      const err = gl.getError();
      if (err) out.glError = err;
      for (const u of test.op.uavs) {
        if (u.after == null) { out.uavs.push({ slot: u.slot, res: u.res, why: '沒有 after 快照' }); continue; }
        const ref = test.snapshots[u.after];
        const bytes = await r.bytesOf(ref);
        const want = snapshotPlanes(ref, bytes).filter(p => p.mip === (u.mip ?? 0));
        const ch = CHANNELS[ref.fmt] ?? 4;
        let maxDiff = 0, diffValues = 0, values = 0, nan = 0, firstDiff = null;
        for (const p of want) {
          const got = readUav(r, u.res, { mip: p.mip, layer: r.tex[u.res].volume ? p.z : p.slice });
          for (let i = 0; i < p.w * p.h; i++) {
            for (let c = 0; c < ch; c++) {
              const a = got.px[i * 4 + c], b = p.px[i * 4 + c];
              values++;
              if (Number.isNaN(a) || Number.isNaN(b)) { if (Number.isNaN(a) !== Number.isNaN(b)) { nan++; diffValues++; } continue; }
              if (a !== b) {
                diffValues++;
                const d = Math.abs(a - b);
                if (d > maxDiff) maxDiff = d;
                firstDiff ??= { x: i % p.w, y: Math.floor(i / p.w), z: p.z, c, got: a, want: b };
              }
            }
          }
        }
        out.uavs.push({ slot: u.slot, res: u.res, mip: u.mip ?? 0, values, diffValues, maxDiff, nan, firstDiff });
      }
    } catch (e) {
      out.error = e.message;
    }
    out.log = r.log;
    for (const t of Object.values(r.tex)) if (t?.tex) gl.deleteTexture(t.tex);
    for (const t of Object.values(r.copies)) if (t?.tex) gl.deleteTexture(t.tex);
    for (const fb of r.fbos.values()) gl.deleteFramebuffer(fb);
    for (const logs of r._csLogs?.values() ?? []) { for (const t of logs.texs) gl.deleteTexture(t); gl.deleteFramebuffer(logs.fb); }
    return out;
  }

  async runAll(filter = () => true) {
    const results = [];
    for (const test of this.m.tests.filter(filter)) results.push(await this.runOne(test));
    return results;
  }
}
