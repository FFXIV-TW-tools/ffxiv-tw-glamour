// 開發用：瀏覽器端逐筆跑 tools/build-shader-id.mjs 的測試——每個候選 PS 用擷取的輸入、常數緩衝、取樣器、狀態、
// 目標原內容重畫一次，與 ShaderProbe 存下的「畫完後」逐像素比對。全吻合的候選＝該筆繪圖實際用的著色器。
// VS 未知：用擷取到的頂點緩衝（每頂點 x,y,u,v；位置 0..1）＋通用映射（NDC＝位置×2−1、TEXCOORD0＝uv、D3D 深度 0）；
// 吻合也同時驗證這個映射（深度只在開了深度測試的繪圖有影響，例：#361／#365 的 GREATER_EQUAL＝只蓋背景）。
import { compileProgram } from '../game/xivgl/pass.js';
import { createSampler, applyState } from '../game/xivgl/d3d.js';
import { createTexture, uploadSnapshot, decodeSnapshot, subresourceList, nullTexture, COLOR } from './textures.js';
import { BUNDLE_BASE } from '../app/config.js';

const BASE = `${BUNDLE_BASE}shader-id/`;
const fetchBytes = async (url) => {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

export const POST_VS = `#version 300 es
precision highp float;
in vec4 a_V;
uniform vec2 xiv_ndc_offset;
out vec4 io_TEXCOORD0;
void main() {
  gl_Position = vec4(a_V.x * 2.0 - 1.0 + xiv_ndc_offset.x, a_V.y * 2.0 - 1.0 + xiv_ndc_offset.y, -1.0, 1.0); // GL z −1＝D3D 深度 0（同 dxbc2glsl 的 [0,w]→[−w,w]）
  io_TEXCOORD0 = vec4(a_V.zw, 0.0, 0.0);
}`;

export class ShaderId {
  static async load(base = BASE) {
    const s = new ShaderId();
    s.base = base;
    s.m = await (await fetch(base + 'manifest.json', { cache: 'no-store' })).json();
    const canvas = document.createElement('canvas');
    s.gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
    const gl = s.gl;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('缺 EXT_color_buffer_float');
    gl.getExtension('EXT_float_blend');
    s.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    s.dbi = gl.getExtension('OES_draw_buffers_indexed');
    s.inputs = new Map();
    s.programs = new Map();
    s.bytes = new Map();
    s.samplerCache = new Map();
    s.nearest = gl.createSampler();
    gl.samplerParameteri(s.nearest, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.samplerParameteri(s.nearest, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    s.scratch = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) - 1;
    return s;
  }

  async bytesOf(ref) {
    const key = ref.url ?? ref.file;
    if (!this.bytes.has(key)) this.bytes.set(key, await fetchBytes(ref.url ?? this.base + ref.file));
    return this.bytes.get(key);
  }

  /** 快照 → 輸入貼圖（依快照序號快取） */
  async inputTexture(ref) {
    if (this.inputs.has(ref.snapshot)) return this.inputs.get(ref.snapshot);
    const gl = this.gl;
    const subs = subresourceList(ref, ref.w, ref.h);
    const mips = Math.max(...subs.map(s => s.mip)) + 1;
    gl.activeTexture(gl.TEXTURE0 + this.scratch);
    const t = createTexture(gl, { w: ref.w, h: ref.h, fmt: ref.fmt, layers: ref.layers, mips });
    uploadSnapshot(gl, t, await this.bytesOf(ref), subs);
    this.inputs.set(ref.snapshot, t);
    return t;
  }

  sampler(desc) {
    const key = JSON.stringify(desc);
    if (!this.samplerCache.has(key)) this.samplerCache.set(key, createSampler(this.gl, desc, this.aniso));
    return this.samplerCache.get(key);
  }

  program(file, src) {
    if (!this.programs.has(file)) {
      try { this.programs.set(file, compileProgram(this.gl, POST_VS, src)); } catch (e) { this.programs.set(file, { error: e.message.slice(0, 200) }); }
    }
    return this.programs.get(file);
  }

  /** 一筆測試的所有候選 → 依吻合度排序的結果 */
  async runTest(test, { maxCandidates = Infinity } = {}) {
    const gl = this.gl;
    if (test.missing.length || !test.rtvs.length) return { i: test.i, ps: test.ps, skipped: test.missing.join(',') || 'no-rtv' };
    const targets = [];
    for (const rt of test.rtvs) {
      const fmt = COLOR[rt.fmt] ? rt.fmt : rt.after.fmt;
      gl.activeTexture(gl.TEXTURE0 + this.scratch);
      const t = createTexture(gl, { w: rt.after.w, h: rt.after.h, fmt, layers: rt.after.layers, mips: (rt.mip ?? 0) + 1 });
      const subs = subresourceList(rt.after, rt.after.w, rt.after.h);
      const sub = subs.find(s => s.mip === (rt.mip ?? 0) && s.slice === (rt.slice ?? 0)) ?? subs[0];
      targets.push({ rt, t, fmt, sub, expected: decodeSnapshot(rt.after.fmt, await this.bytesOf(rt.after), sub) });
    }
    let depth = null;
    if (test.dsv?.before) {
      gl.activeTexture(gl.TEXTURE0 + this.scratch);
      depth = createTexture(gl, { w: test.dsv.before.w, h: test.dsv.before.h, fmt: test.dsv.before.fmt });
    }
    const fb = gl.createFramebuffer();
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, await fetchBytes(this.base + test.vb.file), gl.STATIC_DRAW);
    const cbBytes = {};
    for (const [slot, c] of Object.entries(test.cbs)) cbBytes[slot] = c.file ? await fetchBytes(this.base + c.file) : new Uint8Array(c.size);
    const srvTex = {};
    for (const s of test.srvs) srvTex[s.slot] = { s, t: await this.inputTexture(s.src) };

    // uv 模式：center＝像素中心（不套視埠的 0.5 位移；調色 #425 以此逐像素吻合），viewport＝套視埠位移。先跑 center，最佳者不完全吻合時前 5 名再試 viewport
    const results = [];
    const run = async (cand, uvMode) => {
      const program = this.program(cand.file, await (await fetch(this.base + cand.file, { cache: 'no-store' })).text());
      if (program.error) return { name: cand.name, error: program.error };
      return { ...(await this.runCandidate(test, cand, program, { targets, depth, fb, vbo, cbBytes, srvTex, uvMode })), uvMode };
    };
    for (const cand of test.candidates.slice(0, maxCandidates)) results.push(await run(cand, 'center'));
    const order = (a, b) => (b.match ?? -1) - (a.match ?? -1) || (a.maxAbs ?? 9) - (b.maxAbs ?? 9);
    results.sort(order);
    if ((results[0]?.match ?? 0) < 0.999) {
      for (const r of results.slice(0, 5).filter(r => !r.error)) results.push(await run(test.candidates.find(c => c.name === r.name), 'viewport'));
      results.sort(order);
    }
    gl.deleteFramebuffer(fb);
    gl.deleteBuffer(vbo);
    for (const tg of targets) gl.deleteTexture(tg.t.tex);
    if (depth) gl.deleteTexture(depth.tex);
    return { i: test.i, ps: test.ps, results };
  }

  /** 全部（或 only 指定繪圖序號的）測試 → [{ i, ps, exact: [{name,uvMode}]（完全吻合且無 GL 錯誤）, top: 前 3 名, errors }]；progress(i, n) 可選 */
  async runAll({ progress, only } = {}) {
    const out = [];
    const tests = only ? this.m.tests.filter(t => only.includes(t.i)) : this.m.tests;
    for (const [k, test] of tests.entries()) {
      progress?.(k, tests.length);
      let r;
      try { r = await this.runTest(test); } catch (e) { out.push({ i: test.i, ps: test.ps, error: e.message }); continue; }
      if (r.skipped) { out.push(r); continue; }
      const ok = r.results.filter(x => !x.error);
      out.push({
        i: r.i, ps: r.ps,
        exact: ok.filter(x => x.match >= 0.9999).map(x => ({ name: x.name, uvMode: x.uvMode })),
        top: ok.slice(0, 3), errors: r.results.filter(x => x.error).length,
      });
    }
    return out;
  }

  async runCandidate(test, cand, program, { targets, depth, fb, vbo, cbBytes, srvTex, uvMode }) {
    const gl = this.gl;
    while (gl.getError() !== gl.NO_ERROR); // 前一個候選／建立輸入留下的錯誤不算在這個候選頭上
    // 目標還原成「前」
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    for (let k = 0; k < 8; k++) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, null, 0);
    for (const tg of targets) {
      gl.activeTexture(gl.TEXTURE0 + this.scratch);
      if (tg.rt.before) uploadSnapshot(gl, tg.t, await this.bytesOf(tg.rt.before), subresourceList(tg.rt.before, tg.rt.before.w, tg.rt.before.h));
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      this.attach(tg);
      if (!tg.rt.before) {
        gl.drawBuffers(targets.map(x => (x === tg ? gl.COLOR_ATTACHMENT0 + tg.rt.slot : gl.NONE)));
        gl.colorMask(true, true, true, true);
        gl.clearBufferfv(gl.COLOR, tg.rt.slot, [0, 0, 0, 0]);
      }
    }
    if (depth) { gl.activeTexture(gl.TEXTURE0 + this.scratch); uploadSnapshot(gl, depth, await this.bytesOf(test.dsv.before), subresourceList(test.dsv.before, depth.w, depth.h)); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, depth?.tex ?? null, 0);
    const written = new Set(cand.outputs.filter(o => o.name.toUpperCase() === 'SV_TARGET' && o.used).map(o => o.index));
    const bufs = [];
    for (let k = 0; k <= Math.max(...test.rtvs.map(r => r.slot)); k++) bufs.push(test.rtvs.some(r => r.slot === k) && written.has(k) ? gl.COLOR_ATTACHMENT0 + k : gl.NONE);
    gl.drawBuffers(bufs);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return { name: cand.name, error: 'fbo' };
    if (cand.cb.some(([slot]) => !cbBytes[slot])) return { name: cand.name, error: 'cb-unbound' };

    gl.useProgram(program);
    const ubos = [];
    let binding = 0;
    for (const [slot, vec4s] of cand.cb) {
      const index = gl.getUniformBlockIndex(program, `PS_CB${slot}`);
      if (index === gl.INVALID_INDEX) continue;
      const data = new Uint8Array(vec4s * 16);
      data.set(cbBytes[slot].subarray(0, data.length));
      const ubo = gl.createBuffer();
      ubos.push(ubo);
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, data, gl.STATIC_DRAW);
      gl.uniformBlockBinding(program, index, binding);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, binding++, ubo);
    }
    let unit = 0;
    for (const b of cand.textures) {
      const { s, t } = srvTex[b.t] ?? {};
      if (!t) { // D3D 未綁的 SRV 讀到 0
        gl.activeTexture(gl.TEXTURE0 + this.scratch);
        const z = nullTexture(gl, b.type);
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(z.target, z.tex);
        gl.bindSampler(unit, this.nearest);
        gl.uniform1i(gl.getUniformLocation(program, b.name), unit++);
        continue;
      }
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(t.target, t.tex);
      gl.texParameteri(t.target, gl.TEXTURE_BASE_LEVEL, s.mip ?? 0);
      gl.texParameteri(t.target, gl.TEXTURE_MAX_LEVEL, Math.min(t.mips - 1, (s.mip ?? 0) + Math.max(1, s.mips ?? 1) - 1));
      const desc = test.samplers[b.sampler];
      gl.bindSampler(unit, b.fetch || !desc || (t.depth && !b.compare) ? this.nearest : this.sampler(desc));
      gl.uniform1i(gl.getUniformLocation(program, b.name), unit++);
      const lv = gl.getUniformLocation(program, `ps_t${b.t}_levels`);
      if (lv) gl.uniform1i(lv, t.mips);
    }
    for (const [s] of cand.samplers) {
      const loc = gl.getUniformLocation(program, `ps_s${s}_bias`);
      if (loc) gl.uniform1f(loc, test.samplers[s]?.mipLodBias ?? 0);
    }
    const [vx, vy, vw, vh] = test.viewport;
    gl.viewport(Math.floor(vx), Math.floor(vy), vw, vh);
    const offset = uvMode === 'viewport' ? [(2 * (vx - Math.floor(vx))) / vw, (2 * (vy - Math.floor(vy))) / vh] : [0, 0];
    gl.uniform2f(gl.getUniformLocation(program, 'xiv_ndc_offset'), ...offset);
    gl.disable(gl.SCISSOR_TEST);
    applyState(gl, { ...test.state, rasterizer: { ...test.state.rasterizer, cull: 1 } }, this.dbi);
    if (test.state.blendFactor?.length) gl.blendColor(...test.state.blendFactor);
    if (!depth) { gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const loc = gl.getAttribLocation(program, 'a_V');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, test.vb.stride, test.vb.offset);
    gl.drawArrays(test.topology === 5 ? gl.TRIANGLE_STRIP : gl.TRIANGLES, test.args[1] ?? 0, test.args[0]);
    gl.bindVertexArray(null);
    gl.deleteVertexArray(vao);
    for (let u = 0; u < unit; u++) gl.bindSampler(u, null);
    for (const ubo of ubos) gl.deleteBuffer(ubo);
    const glError = gl.getError();
    if (glError) return { name: cand.name, error: `GL ${glError}` }; // 沒畫成功：目標仍是「前」，不能算吻合

    let total = 0, ok = 0, maxAbs = 0;
    for (const tg of targets) {
      const got = this.read(tg, fb);
      const e = tg.expected.px;
      this.last = { got, expected: e, w: tg.sub.w, h: tg.sub.h }; // 診斷用：最後一個候選的輸出與期望
      const unorm = tg.fmt === 87 || tg.fmt === 28 || tg.fmt === 61 || tg.fmt === 65;
      for (let i = 0; i < e.length; i++) {
        total++;
        if (Number.isNaN(e[i])) { if (Number.isNaN(got[i])) ok++; continue; }
        const d = Math.abs(got[i] - e[i]);
        const tol = unorm ? 1.01 / 255 : 2e-3 * Math.max(1, Math.abs(e[i]));
        if (d <= tol) ok++;
        else if (d > maxAbs) maxAbs = d;
      }
    }
    return { name: cand.name, exact: cand.exact, match: ok / total, maxAbs };
  }

  attach(tg) {
    const gl = this.gl;
    const k = gl.COLOR_ATTACHMENT0 + tg.rt.slot;
    if (tg.t.layers > 1) gl.framebufferTextureLayer(gl.FRAMEBUFFER, k, tg.t.tex, tg.rt.mip ?? 0, tg.rt.slice ?? 0);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, k, gl.TEXTURE_2D, tg.t.tex, tg.rt.mip ?? 0);
  }

  /** 目標的指定子資源 → Float32 RGBA（邏輯通道；未使用的通道補成與快照解碼一致） */
  read(tg, fb) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + tg.rt.slot);
    const { w, h } = tg.sub;
    let px;
    if (tg.t.internal === 'RGBA8' || tg.t.internal === 'R8') {
      const b = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
      px = Float32Array.from(b, v => v / 255);
    } else {
      px = new Float32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
    }
    const keep = { 61: 1, 41: 1, 34: 2 }[tg.fmt];
    if (keep) for (let i = 0; i < w * h; i++) for (let c = keep; c < 4; c++) px[i * 4 + c] = 0;
    if (tg.fmt === 26) for (let i = 0; i < w * h; i++) px[i * 4 + 3] = 1;
    return px;
  }
}
