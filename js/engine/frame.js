// 完整一幀：依 tools/build-replay-frame.mjs 產生的背景包 manifest.json，
// 在 WebGL2 逐筆重播遊戲的清除與繪圖（翻譯後的遊戲 VS／PS、擷取的常數緩衝／取樣器／管線狀態／頂點緩衝）。
// 慣例同 tools/dxbc2glsl.mjs：畫面上下顛倒渲染，GL 第 0 列＝D3D 最上列；D3D 資源以 manifest 的資源位址為鍵。
// 讀回與比對見 dev/frame-read.js。曲面細分繪圖（op.vs＝'tess'）改畫擷取的 DS 輸出頂點，見 tess.js。
import { applyState } from '../game/xivgl/d3d.js';
import { nullTexture } from './textures.js';
import { fetchBytes, textDecoder } from './frame-files.js';
import { FrameGeometry } from './frame-geometry.js';
import { depthCopy, constFill } from './frame-special.js';
import { tessSetup, bindTessCrop } from './tess.js';
import { dispatch } from './compute.js';
import { BUNDLE_BASE } from '../app/config.js';

export class FrameReplay extends FrameGeometry {
  constructor(manifest, gl) {
    super();
    this.m = manifest;
    this.gl = gl;
    this.tex = {};        // 資源鍵 → createTexture 的描述（另加 compressed／structured）
    this.cubes = {};
    this.copies = {};
    this.programs = {};
    this.vaos = {};
    this.ubos = {};
    this.boundUbos = []; // 同一索引已綁同 buffer 時不再呼叫 WebGL（森林每輪約 1,747／4,541 次）
    this.log = [];
    this.fbos = new Map();
    this.ext = {
      cbf: gl.getExtension('EXT_color_buffer_float'),
      aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
      dbi: gl.getExtension('OES_draw_buffers_indexed'),
      floatBlend: gl.getExtension('EXT_float_blend'),
    };
    if (!this.ext.cbf) throw new Error('缺 EXT_color_buffer_float');
    this.samplerCache = new Map();
    this.nearest = gl.createSampler();
    gl.samplerParameteri(this.nearest, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.samplerParameteri(this.nearest, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.scratchUnit = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) - 1; // 建立／上傳用，不和繪圖綁定衝突
  }

  bindUbo(index, buffer) {
    if (this.boundUbos[index] === buffer) return;
    this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, index, buffer);
    this.boundUbos[index] = buffer;
  }

  /** 下載 manifest 後，同時取齊衍生資料與玩家本機遊戲資料；首幀只讀 byteCache。 */
  static async load(base = `${BUNDLE_BASE}frame/`, canvas = document.createElement('canvas'), { onProgress, onClientProgress, onCompile, cacheName, packs } = {}) {
    let cache = null;
    if (cacheName && typeof caches !== 'undefined') {
      try { cache = await caches.open(cacheName); } catch { /* Cache Storage 不可用時照常以網路載入。 */ }
    }
    const manifestUrl = base + 'manifest.json';
    let manifestBytes, manifestFromCache = false;
    try { manifestBytes = cache && new Uint8Array(await (await cache.match(manifestUrl))?.arrayBuffer()); } catch { /* 快取讀取失敗改用網路。 */ }
    if (manifestBytes?.byteLength) manifestFromCache = true;
    if (!manifestBytes?.byteLength) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          manifestBytes = await fetchBytes(manifestUrl);
          if (cache) try { await cache.put(manifestUrl, new Response(manifestBytes)); } catch { /* 快取寫入失敗不影響載入。 */ }
          break;
        } catch (e) { if (attempt === 2) throw new Error(`${manifestUrl} 下載失敗（重試 2 次）：${e.message}`); }
      }
    }
    const manifest = JSON.parse(textDecoder.decode(manifestBytes));
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
    const r = new FrameReplay(manifest, gl);
    r.base = base;
    r.packs = packs;
    r.setupCompile(onCompile);
    await Promise.all([
      r.prefetchFiles(onProgress, cache, { bytes: manifestBytes.byteLength, fromCache: manifestFromCache }),
      r.prefetchClientFiles(onClientProgress),
    ]);
    return r;
  }
  /** shader program 的共用 key 去重：同 VS/PS 組合只在第一次連結時增加進度。 */
  setupCompile(onCompile) {
    if (!onCompile) return;
    const expected = new Set(['special:present']);
    for (const op of this.m.ops) {
      if (op.special) { expected.add(`special:${op.special}`); continue; }
      if (op.op === 'draw') {
        if (op.vs === 'tess') expected.add(`tess:${op.ps}|${JSON.stringify(this.m.geometry[op.geometry].elements)}`);
        else expected.add(`draw:${op.vs}|${op.ps}`);
      }
      if (op.op !== 'dispatch') continue;
      const info = this.m.shaders[op.cs];
      if (!info || info.stage !== 'cs' || op.threadGroups?.some(g => g === 0) ||
        info.textures.find(b => b.compare && !op.samplers?.[b.sampler])) continue;
      expected.add(`cs:${op.cs}`);
      if (info.mode === 'group' && 2 * info.stores.length <= this.gl.getParameter(this.gl.MAX_DRAW_BUFFERS)) {
        for (const s of info.stores) {
          if (!op.uavs.some(u => u.slot === s.uav)) continue;
          const type = info.uavs.find(u => u.slot === s.uav)?.valueType;
          if (type) expected.add(`scatter:${type}`);
        }
      }
    }
    const completed = new Set();
    this.noteCompile = key => {
      if (!expected.has(key) || completed.has(key)) return;
      completed.add(key);
      onCompile({ done: completed.size, total: expected.size });
    };
    onCompile({ done: 0, total: expected.size });
  }
  // ---------- 執行 ----------
  /**
   * onBefore／onOp：每個操作（含上傳）執行前／後呼叫並等待；skip 只供互動預覽略過停手後可補的後處理。
   * 第二次起重跑：資源不重建，只把「有初始快照、又會被本幀寫到」的資源還原，並呼叫 onReset（呼叫端重設自己改過的輸入）。
   */
  async run({ until = Infinity, onBefore, onOp, skip } = {}) {
    if (!this.created) { await this.createResources(); this.created = true; await this.onReset?.(); } else await this.reset();
    const gl = this.gl;
    this.frameNo = (this.frameNo ?? 0) + 1;
    for (const op of this.m.ops) {
      if ((op.i ?? op.at) > until) break;
      if (skip?.(op)) continue;
      await onBefore?.(op);
      if (op.op === 'upload') await this.upload(op.res, op);
      else if (op.op === 'clearRT') this.clearRT(op);
      else if (op.op === 'clearDS') this.clearDS(op);
      else if (op.op === 'copy') this.copyLevels(this.tex[op.src], this.tex[op.dst], 0, 1); // 整張 CopySubresourceRegion（子資源 0、同尺寸同格式）
      else if (op.special === 'depthCopy') depthCopy(this, op);
      else if (op.special === 'constFill') constFill(this, op);
      else if (op.op === 'dispatch') await dispatch(this, op); // compute（js/engine/compute.js）
      else await this.draw(op);
      for (const key of this.versionWrites(op)) this.bump(key);
      if (this.checkErrors !== false) { // getError 會同步等 GPU 行程；互動顯示時關掉
        const e = gl.getError();
        if (e) this.log.push(`#${op.i ?? op.at} ${op.op} GL 錯誤 ${e}`);
      }
      await onOp?.(op);
    }
  }

  /** 會改變「取樣到的內容」的寫入（深度模板只算寫深度；只改模板不影響深度取樣） */
  versionWrites(op) {
    if (op.op === 'upload') return [op.res];
    if (op.op === 'dispatch') return op.uavs.map(u => u.res);
    if (op.op === 'clearRT') return [op.rt.res];
    if (op.op === 'clearDS') return op.flags & 1 ? [op.ds] : [];
    if (op.op === 'copy') return [op.dst];
    const ds = op.state?.depthStencil;
    return [...op.rtvs.map(r => r.res), ...(op.dsv && ds?.depth && ds.depthWrite === 1 ? [op.dsv.res] : [])];
  }

  /** 本幀會寫到的資源 */
  written() {
    if (!this.writtenKeys) {
      this.writtenKeys = new Set();
      for (const op of this.m.ops) {
        if (op.op === 'clearRT') this.writtenKeys.add(op.rt.res);
        else if (op.op === 'clearDS') this.writtenKeys.add(op.ds);
        else if (op.op === 'copy') this.writtenKeys.add(op.dst);
        else if (op.op === 'draw') { for (const r of op.rtvs) this.writtenKeys.add(r.res); if (op.dsv) this.writtenKeys.add(op.dsv.res); }
        else if (op.op === 'dispatch') for (const u of op.uavs) this.writtenKeys.add(u.res);
      }
    }
    return this.writtenKeys;
  }

  async reset() {
    for (const [key, r] of Object.entries(this.m.resources)) {
      if (r.init?.kind !== 'snapshot' || !this.written().has(key)) continue;
      if (this.pristine?.[key]) this.copyLevels(this.pristine[key], this.tex[key]);
      else await this.upload(key, r.init);
      this.bump(key);
    }
    await this.onReset?.();
  }

  clearRT(op) {
    const gl = this.gl;
    const t = this.tex[op.rt.res];
    if (!t) return;
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    if (this.ext.dbi) this.ext.dbi.colorMaskiOES(0, true, true, true, true);
    for (let s = op.rt.slice; s < op.rt.slice + Math.max(1, op.rt.slices); s++) {
      this.fbo([{ ...op.rt, slice: s }], null);
      gl.clearBufferfv(gl.COLOR, 0, op.color);
    }
  }

  clearDS(op) {
    const gl = this.gl;
    const t = this.tex[op.ds];
    if (!t) return;
    this.fbo([], { res: op.ds });
    gl.depthMask(true);
    gl.stencilMask(0xff);
    const depth = (op.flags & 1) !== 0, stencil = (op.flags & 2) !== 0 && t.stencil;
    if (depth && stencil) gl.clearBufferfi(gl.DEPTH_STENCIL, 0, op.depth, op.stencil);
    else if (depth) gl.clearBufferfv(gl.DEPTH, 0, [op.depth]);
    else if (stencil) gl.clearBufferiv(gl.STENCIL, 0, [op.stencil]);
  }

  viewportAndDepth(vp) {
    const gl = this.gl;
    const [vx, vy, vw, vh, zmin = 0, zmax = 1] = vp;
    gl.viewport(Math.floor(vx), Math.floor(vy), vw, vh);
    gl.depthRange(zmin, zmax);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** D3D 未綁的 SRV：取樣／讀取都得 0 → 綁同型別的 1×1 全零貼圖 */
  bindNull(program, b, unit) {
    const gl = this.gl;
    this.scratch();
    const t = nullTexture(gl, b.type);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(t.target, t.tex);
    gl.bindSampler(unit, this.nearest);
    gl.uniform1i(this.loc(program, b.name), unit);
  }

  /** uniform 位置／block 索引（每個 program 查一次） */
  loc(program, name) {
    this.locs ??= new WeakMap();
    if (!this.locs.has(program)) this.locs.set(program, new Map());
    const m = this.locs.get(program);
    if (!m.has(name)) m.set(name, name.startsWith('block:') ? this.gl.getUniformBlockIndex(program, name.slice(6)) : this.gl.getUniformLocation(program, name));
    return m.get(name);
  }

  async draw(op) {
    const gl = this.gl;
    const progKey = `${op.vs}|${op.ps}`;
    // 曲面細分（op.vs＝'tess'）：畫 DS 輸出頂點＋自產 pass-through VS（tess.js）；和 PS 輸入簽章對不上就整筆不畫並記錄原因
    const tess = op.vs === 'tess';
    let program, geo;
    if (tess) {
      try { ({ program, geo } = await tessSetup(this, op)); } catch (e) { this.log.push(`#${op.i} 曲面細分未重播：${e.message}`); return; }
    } else {
      program = await this.program(op.vs, op.ps);
      geo = await this.vao(program, progKey, op.geometry);
    }
    gl.useProgram(program);
    if (tess) bindTessCrop(this, program);
    const vsInfo = op.vs === 'post' || tess ? null : this.m.shaders[op.vs];
    const psInfo = this.m.shaders[op.ps];
    // 取樣器表依階段：PS＝op.samplers、VS＝op.vsSamplers（D3D11 各階段各自一組 s 暫存器，不可拿 PS 的表給 VS）。
    // VS 有取樣（非 texelFetch）卻沒有擷取 VS 取樣器狀態 → 過濾／比較函式無從得知，明確跳過並記錄（不猜）。
    // 例：第 12 版海岸 #1731 apricot_powder-vs9 以 sampler2DShadow 取樣陰影圖，舊擷取沒有 vsSamplers；
    // 原本誤用 PS s0（非比較取樣器）→ 深度貼圖＋shadow sampler 缺 COMPARE_MODE → drawElements INVALID_OPERATION（一樣沒畫，只是沒記錄原因）
    const stageSamplers = { ps: op.samplers, vs: op.vsSamplers };
    if (vsInfo?.textures.some(b => !b.fetch && b.type !== 'structured' && op.vsSrvs.some(s => s.slot === b.t)) && !op.vsSamplers) {
      this.log.push(`#${op.i} ${op.vs} 在 VS 取樣但擷取沒有 VS 取樣器狀態，未重播`);
      return;
    }

    let binding = 0;
    for (const [stage, list] of [['VS', op.vsCbs], ['PS', op.psCbs]]) {
      for (const [slot, v] of Object.entries(list)) {
        const index = this.loc(program, `block:${stage}_CB${slot}`);
        if (index === gl.INVALID_INDEX) continue;
        gl.uniformBlockBinding(program, index, binding);
        // cbHook：呼叫端可換掉某筆繪圖的常數緩衝（例：轉動角色時重算骨架矩陣），回傳 null＝用原內容
        const patched = this.cbHook ? await this.cbHook(op, stage, Number(slot), v) : null;
        this.bindUbo(binding, patched ?? await this.ubo(v.file, v.size));
        binding++;
      }
    }

    // 貼圖：每個 t×s 組合一個 uniform；取樣 mip 範圍＝SRV 視圖；讀的資源同時被綁成目標 → 先複製；D3D 未綁的 SRV 讀到 0
    const ds = op.state.depthStencil;
    const dsv = op.dsv && (ds?.depth || ds?.stencil) ? op.dsv : null; // 深度模板都關時不掛（GL 要求附件同尺寸，D3D 不要求）
    const attached = new Set([...op.rtvs.map(r => r.res), dsv?.res].filter(Boolean));
    let unit = 0;
    for (const [info, prefix, views] of [[psInfo, 'ps', op.srvs], [vsInfo, 'vs', op.vsSrvs]]) {
      if (!info) continue;
      for (const b of info.textures) {
        const srv = views.find(s => s.slot === b.t);
        if (!srv) { this.bindNull(program, b, unit++); continue; }
        let t = b.type === 'texturecube' ? await this.cubeOf(srv.res) : this.tex[srv.res];
        if (!t) { this.log.push(`#${op.i} ${prefix} t${b.t} 沒有資源 ${srv.res}`); continue; }
        if (b.type === 'structured' ? !t.structured : t.structured) { this.log.push(`#${op.i} ${prefix} t${b.t} 型別不符（${b.type}）`); continue; }
        const mips = Math.max(1, Math.min(srv.mips, t.mips - srv.mip));
        if (attached.has(srv.res) && b.type !== 'texturecube') t = this.readableCopy(srv.res, srv.mip, mips);
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(t.target, t.tex);
        if (!t.structured) {
          gl.texParameteri(t.target, gl.TEXTURE_BASE_LEVEL, srv.mip);
          gl.texParameteri(t.target, gl.TEXTURE_MAX_LEVEL, srv.mip + mips - 1);
        }
        gl.bindSampler(unit, b.fetch || t.structured ? this.nearest : this.sampler(stageSamplers[prefix][b.sampler], t.depth && !b.compare));
        gl.uniform1i(this.loc(program, b.name), unit++);
        const levels = this.loc(program, `${prefix}_t${b.t}_levels`);
        if (levels) gl.uniform1i(levels, mips);
      }
      for (const s of info.samplers ?? []) {
        const loc = this.loc(program, `${prefix}_s${s[0]}_bias`);
        if (loc) gl.uniform1f(loc, stageSamplers[prefix]?.[s[0]]?.mipLodBias ?? 0);
      }
    }

    const outputs = new Set(psInfo.outputs.filter(o => /^SV_TARGET$/i.test(o.name) && o.used).map(o => o.index)); // 簽章有列但沒寫＝不宣告輸出
    this.fbo(op.rtvs.reduce((a, r) => { a[r.slot] = r; return a; }, []), dsv, outputs);
    this.viewportAndDepth(op.viewport);
    const [vx, vy, vw, vh] = op.viewport;
    const off = this.loc(program, 'xiv_ndc_offset');
    // 後製 PS 的 uv 模式（辨識時逐像素驗證）：center＝不套視埠的半像素位移；其餘照視埠位移
    if (off) gl.uniform2f(off, ...(op.uvMode === 'center' ? [0, 0] : [(2 * (vx - Math.floor(vx))) / vw, (2 * (vy - Math.floor(vy))) / vh]));
    const post = this.m.geometry[op.geometry].kind === 'post';
    applyState(gl, post ? { ...op.state, rasterizer: { ...op.state.rasterizer, cull: 1 } } : op.state, this.ext.dbi);
    if (op.state.blendFactor) gl.blendColor(...op.state.blendFactor);
    if (!dsv) { gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); }

    gl.bindVertexArray(geo.vao);
    const d = geo.draw;
    if (d.type !== undefined) { if (d.instances > 1) gl.drawElementsInstanced(d.mode, d.count, d.type, d.offset, d.instances); else gl.drawElements(d.mode, d.count, d.type, d.offset); }
    else if (d.instances > 1) gl.drawArraysInstanced(d.mode, d.first, d.count, d.instances);
    else gl.drawArrays(d.mode, d.first, d.count);
    gl.bindVertexArray(null);
    for (let u = 0; u < unit; u++) gl.bindSampler(u, null);
  }
}
