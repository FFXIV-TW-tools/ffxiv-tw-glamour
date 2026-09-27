// FrameReplay 的 shader program、VAO/頂點格式、UBO、sampler 與 framebuffer。
import { compileProgram, bindVertexStreams } from '../game/xivgl/pass.js';
import { createSampler } from '../game/xivgl/d3d.js';
import { POST_VS } from './shader-id.js';
import { VERTEX_FORMATS } from './vertex-formats.js';
import { memo, textDecoder } from './frame-files.js';
import { FrameResources } from './frame-resources.js';

const TOPOLOGY = { 1: 'POINTS', 2: 'LINES', 3: 'LINE_STRIP', 4: 'TRIANGLES', 5: 'TRIANGLE_STRIP' };
const SIGNED = new Set(['BYTE', 'SHORT', 'INT']); // VERTEX_FORMATS 的有號整數型別
export class FrameGeometry extends FrameResources {
  // ---------- 著色器、幾何、常數 ----------
  async program(vsName, psName) {
    const key = `${vsName}|${psName}`;
    if (this.programs[key]) return this.programs[key];
    const vs = vsName === 'post' ? POST_VS : textDecoder.decode(await this.bytesOf({ file: this.m.shaders[vsName].file }));
    const ps = textDecoder.decode(await this.bytesOf({ file: this.m.shaders[psName].file }));
    const program = compileProgram(this.gl, vs, ps);
    this.programs[key] = program;
    this.noteCompile?.(`draw:${key}`);
    // 第一次畫某個背景要連續編 100 多支著色器（數十秒），全程佔住主執行緒時頁面的下載／編譯進度不會重畫：
    // 編新著色器時每隔 100 ms 讓出一次（只影響首幀；之後程式都已快取、不會走到這裡）
    if (performance.now() - (this.lastYield ?? 0) > 100) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      this.lastYield = performance.now();
    }
    return program;
  }

  async vao(program, progKey, geometry) {
    const gl = this.gl;
    const key = `${progKey}|${geometry}`;
    if (this.vaos[key]) return this.vaos[key];
    const g = this.m.geometry[geometry];
    let vao, draw;
    if (g.kind === 'mesh') {
      const buffers = [];
      for (const [k, s] of g.streams.entries()) {
        if (!s) continue;
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, await this.bytesOf({ file: s.file }), gl.STATIC_DRAW);
        buffers[k] = { buffer, stride: s.stride };
      }
      vao = bindVertexStreams(gl, program, g.decl, buffers);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, await this.bytesOf({ file: g.indices }), gl.STATIC_DRAW);
      draw = { mode: gl.TRIANGLES, count: g.count, type: gl.UNSIGNED_SHORT, offset: 0 };
    } else if (g.kind === 'layout') {
      // 依 input layout（js/engine/vertex-formats.js）接擷取的頂點緩衝：每個元素的槽、位移、格式、每實例步進。
      // WebGL 沒有 baseVertex／startInstance → 併入每頂點／每實例屬性的位移。整數或浮點依 program 內該屬性的宣告型別；
      // 整數格式與屬性的有號／無號不同時（例：乙太空間 #487 R16G16B16A16_SINT → uvec4；WebGL2 視為型別不符、整筆 INVALID_OPERATION），
      // 照 D3D11 語意（依格式本身做 32 位元延伸，再以位元原樣交給著色器）在 JS 端展開成 32 位元整數緩衝（widened）
      const vbs = {}, widened = {};
      for (const [slot, vb] of Object.entries(g.vbs)) vbs[slot] = await this.glBuffer(vb, gl.ARRAY_BUFFER); // 先建好緩衝再綁 VAO（建立時會動到綁定）
      const kinds = {};
      for (const e of g.elements) {
        const f = VERTEX_FORMATS[e.fmt];
        const kind = kinds[e.name] = this.attribKind(program, e.name);
        if (kind === 'float' || !f.integer || f.bytes / f.size === 4 || SIGNED.has(f.type) === (kind === 'int')) continue;
        widened[e.name] = await this.widenedBuffer(g.vbs[e.slot], e, f);
      }
      const ib = g.ib && await this.glBuffer(g.ib, gl.ELEMENT_ARRAY_BUFFER);
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      for (const e of g.elements) {
        const loc = gl.getAttribLocation(program, e.name);
        if (loc < 0) continue;
        const vb = g.vbs[e.slot], f = VERTEX_FORMATS[e.fmt], kind = kinds[e.name], w = widened[e.name];
        const first = e.instance ? g.firstInstance : g.baseVertex;
        gl.bindBuffer(gl.ARRAY_BUFFER, w ? w.buffer : vbs[e.slot]);
        gl.enableVertexAttribArray(loc);
        if (kind === 'float') {
          if (f.integer) this.log.push(`${progKey} ${e.name}：整數格式 ${e.fmt} 接浮點屬性（D3D 為位元重解讀，未支援）`);
          gl.vertexAttribPointer(loc, f.size, gl[f.type], !!f.normalized, vb.stride, vb.offset + e.offset + first * vb.stride);
        } else if (w) gl.vertexAttribIPointer(loc, f.size, kind === 'int' ? gl.INT : gl.UNSIGNED_INT, w.stride, first * w.stride);
        else gl.vertexAttribIPointer(loc, f.size, f.bytes / f.size === 4 ? (kind === 'int' ? gl.INT : gl.UNSIGNED_INT) : gl[f.type], vb.stride, vb.offset + e.offset + first * vb.stride);
        gl.vertexAttribDivisor(loc, e.instance ? Math.max(1, e.step) : 0);
      }
      draw = this.drawCall(g, ib);
    } else {
      // 擷取的頂點緩衝：slot 0 只含位置（遊戲 VS：POSITION，分量數＝stride/4）或 x,y,u,v（後製 VS）；WebGL 沒有 baseVertex → 併入屬性位移
      const vb = await this.glBuffer(g.vb, gl.ARRAY_BUFFER);
      const ib = g.ib && await this.glBuffer(g.ib, gl.ELEMENT_ARRAY_BUFFER);
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      const post = g.kind === 'post';
      const loc = gl.getAttribLocation(program, post ? 'a_V' : 'a_POSITION0');
      if (loc < 0) this.log.push(`${progKey} 沒有位置屬性`);
      else {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, post ? 4 : Math.min(4, g.vb.stride / 4), gl.FLOAT, false, g.vb.stride, g.vb.offset + g.baseVertex * g.vb.stride);
      }
      draw = this.drawCall({ ...g, instances: 1 }, ib);
    }
    gl.bindVertexArray(null);
    return (this.vaos[key] = { vao, draw });
  }

  /** 擷取的緩衝 → GL 緩衝（同一來源、同一用途只建一次；WebGL 規定索引緩衝不可再當頂點緩衝）。建立時先解除 VAO，免得索引緩衝掛到別人的 VAO。
   *  頂點緩衝尾端補 64 bytes 零：D3D 超出緩衝的頂點讀取得 0（layout 元素可超出 stride，見 build-replay-frame.mjs fitLayout），WebGL 則是繪圖錯誤 */
  glBuffer(src, target) {
    const gl = this.gl;
    const url = src.url ?? this.base + src.file;
    this.glBuffers ??= new Map();
    const key = `${target}|${url}`;
    return memo(this.glBuffers, key, () => this.bytesOf(src).then((bytes) => {
      gl.bindVertexArray(null);
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      if (target === gl.ARRAY_BUFFER) { const padded = new Uint8Array(bytes.length + 64); padded.set(bytes); bytes = padded; }
      gl.bufferData(target, bytes, gl.STATIC_DRAW);
      return b;
    }));
  }

  /** program 內頂點屬性的宣告基本型別：'int'（ivec／int）、'uint'（uvec／uint）、'float' */
  attribKind(program, name) {
    const gl = this.gl;
    const n = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
    for (let k = 0; k < n; k++) {
      const a = gl.getActiveAttrib(program, k);
      if (a.name !== name) continue;
      if ([gl.INT, gl.INT_VEC2, gl.INT_VEC3, gl.INT_VEC4].includes(a.type)) return 'int';
      if ([gl.UNSIGNED_INT, gl.UNSIGNED_INT_VEC2, gl.UNSIGNED_INT_VEC3, gl.UNSIGNED_INT_VEC4].includes(a.type)) return 'uint';
    }
    return 'float';
  }

  /** 8／16 位元整數頂點元素 → 每頂點 size 個 32 位元整數（依格式本身有號／無號延伸＝D3D11 讀法；尾端補 64 bytes 零，同 glBuffer） */
  widenedBuffer(vb, e, f) {
    const url = vb.url ?? this.base + vb.file;
    const key = `${url}|${vb.stride}|${vb.offset + e.offset}|${e.fmt}`;
    return memo(this.widened ??= new Map(), key, () => this.bytesOf(vb).then((bytes) => {
      const gl = this.gl, bits = f.bytes / f.size * 8, start = vb.offset + e.offset;
      const count = bytes.length >= start + f.bytes ? Math.floor((bytes.length - start - f.bytes) / vb.stride) + 1 : 0;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const read = { '8s': (p) => dv.getInt8(p), '8u': (p) => dv.getUint8(p), '16s': (p) => dv.getInt16(p, true), '16u': (p) => dv.getUint16(p, true) }[`${bits}${SIGNED.has(f.type) ? 's' : 'u'}`];
      const out = new Int32Array(count * f.size + 16);
      for (let v = 0; v < count; v++) for (let c = 0; c < f.size; c++) out[v * f.size + c] = read(start + v * vb.stride + c * bits / 8);
      gl.bindVertexArray(null);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, out, gl.STATIC_DRAW);
      return { buffer, stride: f.size * 4 };
    }));
  }

  /** 擷取幾何的繪製參數（呼叫時 VAO 已綁定：索引緩衝掛在 VAO 上） */
  drawCall(g, ib) {
    const gl = this.gl;
    const mode = gl[TOPOLOGY[g.topology]];
    if (mode === undefined) throw new Error(`未支援的拓撲 ${g.topology}`);
    const instances = g.instances ?? 1;
    if (!g.ib) return { mode, count: g.count, first: g.first, instances };
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    const u32 = g.ib.type === 'u32';
    return { mode, count: g.count, type: u32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, offset: g.ib.offset + g.first * (u32 ? 4 : 2), instances };
  }

  /** 常數緩衝內容（補零到 size） */
  async cbBytes(file, size) {
    const bytes = new Uint8Array(size);
    if (file) { const b = await this.bytesOf({ file }); bytes.set(b.subarray(0, size)); }
    return bytes;
  }

  /** 常數緩衝 → UBO（this.ubos 是物件：equip.js 換裝時依檔名刪除；失敗時同樣移除快取） */
  ubo(file, size) {
    const key = `${file}|${size}`;
    if (this.ubos[key]) return this.ubos[key];
    return (this.ubos[key] = (async () => {
      const gl = this.gl;
      const bytes = await this.cbBytes(file, size);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.UNIFORM_BUFFER, buf);
      gl.bufferData(gl.UNIFORM_BUFFER, bytes, gl.STATIC_DRAW);
      return buf;
    })().catch((e) => { delete this.ubos[key]; throw e; }));
  }

  sampler(desc, depthNoCompare) {
    if (!desc || depthNoCompare) return this.nearest; // 深度貼圖不比較時不可線性過濾
    const key = JSON.stringify(desc);
    if (!this.samplerCache.has(key)) this.samplerCache.set(key, createSampler(this.gl, desc, this.ext.aniso));
    return this.samplerCache.get(key);
  }

  /** colors：依槽位的 RTV 視圖（mip／slice）；written：PS 有輸出的槽（D3D 不寫未輸出的 RT；GL 要求作用中的 draw buffer 都有輸出）→ 其餘設 NONE */
  fbo(colors, depthView, written = null) {
    const gl = this.gl;
    const key = `${colors.map(c => (c ? `${c.res}@${c.mip}.${c.slice}` : '-')).join(',')}|${depthView?.res ?? ''}`;
    for (const c of colors) if (c) this.fullRange(this.tex[c.res]);
    let fb = this.fbos.get(key);
    const attach = (point, v) => {
      const t = this.tex[v.res];
      if (t.layers > 1) gl.framebufferTextureLayer(gl.FRAMEBUFFER, point, t.tex, v.mip ?? 0, v.slice ?? 0);
      else gl.framebufferTexture2D(gl.FRAMEBUFFER, point, gl.TEXTURE_2D, t.tex, v.mip ?? 0);
    };
    if (!fb) {
      fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      colors.forEach((c, slot) => { if (c) attach(gl.COLOR_ATTACHMENT0 + slot, c); });
      if (depthView) attach(this.tex[depthView.res].stencil ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT, depthView);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER); // 查詢會同步等 GPU 行程：只在建立時查
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`FBO 不完整 ${key} ${status}`);
      this.fbos.set(key, fb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.drawBuffers(colors.length ? colors.map((c, slot) => (c && (!written || written.has(slot)) ? gl.COLOR_ATTACHMENT0 + slot : gl.NONE)) : [gl.NONE]);
    return fb;
  }

}
