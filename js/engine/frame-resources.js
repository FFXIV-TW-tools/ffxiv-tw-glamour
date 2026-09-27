// FrameReplay 的 GPU 貼圖、快照、緩衝與版本化資源管理。
import { uploadTexture } from '../game/xivgl/pass.js';
import { createTexture, uploadSnapshot, subresourceList } from './textures.js';
import { SB_WIDTH } from './storage-layout.js';
import { FrameFiles } from './frame-files.js';

export class FrameResources extends FrameFiles {
  scratch() { this.gl.activeTexture(this.gl.TEXTURE0 + this.scratchUnit); }

  // ---------- 資源 ----------
  async createResources() {
    const gl = this.gl;
    for (const [key, r] of Object.entries(this.m.resources)) {
      this.scratch();
      if (r.init?.kind === 'sqpack') {
        const t = uploadTexture(gl, r.init, await this.bytesOf(r.init));
        this.tex[key] = { ...t, w: r.w, h: r.h, layers: r.init.arraySize, mips: r.init.mips.length, compressed: true };
        continue;
      }
      if (r.dim === 1) { if (r.init) this.tex[key] = this.structured(await this.bytesOf(r.init)); continue; }
      // dim 4＝3D 貼圖（深度 d 當 layers，createTexture volume）
      try { this.tex[key] = createTexture(gl, { w: r.w, h: r.h, fmt: r.fmt, layers: r.dim === 4 ? r.d : (r.array ?? 1), mips: r.mips ?? 1, volume: r.dim === 4 }); } catch (e) { this.log.push(`${key}：${e.message}`); continue; }
      if (r.init?.kind === 'snapshot') { await this.upload(key, r.init); this.keepPristine(key); }
    }
  }

  /** 遊戲快照 → 資源（全部子資源；舊快照只有第 0 層時複製到全部層並記錄） */
  async upload(key, src) {
    const bytes = await this.bytesOf(src);
    if (this.m.resources[key].dim === 1) { this.tex[key] = this.structured(bytes); return; }
    const t = this.tex[key];
    if (!t) return;
    this.scratch();
    if (uploadSnapshot(this.gl, t, bytes, subresourceList(src, t.w, t.h), { replicateLayers: true })) this.log.push(`快照只有第 0 層，複製到 ${t.layers} 層：${key}`);
  }

  /** 結構化緩衝 → R32UI 資料貼圖（每 texel 一個 dword、每列 SB_WIDTH 個；同 dxbc2glsl） */
  structured(bytes) {
    const gl = this.gl;
    const dwords = Math.max(1, Math.ceil(bytes.length / 4));
    const w = Math.min(SB_WIDTH, dwords), h = Math.ceil(dwords / SB_WIDTH);
    const words = new Uint32Array(w * h);
    new Uint8Array(words.buffer).set(bytes);
    this.scratch();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, w, h);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, gl.UNSIGNED_INT, words);
    return { tex, target: gl.TEXTURE_2D, internal: 'R32UI', w, h, layers: 1, mips: 1, structured: true };
  }

  /** 立方體 SRV（texturecube）：以資源的初始快照另建 GL 立方體貼圖；D3D 面序與 GL 相同，列序不需翻轉 */
  async cubeOf(key) {
    if (this.cubes[key]) return this.cubes[key];
    const r = this.m.resources[key];
    if (r.init?.kind !== 'snapshot' || r.uploads?.length) { this.log.push(`立方體 ${key} 不是單純的快照輸入，未支援`); return null; }
    this.scratch();
    const t = createTexture(this.gl, { w: r.w, h: r.h, fmt: r.fmt, layers: 6, mips: r.mips ?? 1, cube: true });
    uploadSnapshot(this.gl, t, await this.bytesOf(r.init), subresourceList(r.init, r.w, r.h));
    return (this.cubes[key] = t);
  }

  /** 讀寫同一資源（GL 視為回授迴圈）：讀的 mip 範圍先複製到暫存貼圖；來源自上次複製後沒被寫過就沿用 */
  readableCopy(key, mip, mips) {
    const gl = this.gl;
    const t = this.tex[key];
    if (t.layers > 1) { this.log.push(`陣列資源同時讀寫未支援：${key}`); return t; }
    let c = this.copies[key];
    if (!c) {
      this.scratch();
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, t.mips, t.glInternal ?? gl[t.internal], t.w, t.h);
      c = this.copies[key] = { ...t, tex, copied: null };
    }
    const stamp = `${this.versions?.[key] ?? 0}|${mip}|${mips}|${this.frameNo ?? 0}`;
    if (c.copied !== stamp) { this.copyLevels(t, c, mip, mips); c.copied = stamp; }
    return c;
  }

  /** 本幀寫入計數：readableCopy 判斷來源有沒有變（深度模板只算會改深度的寫入；取樣只讀深度） */
  bump(key) { (this.versions ??= {})[key] = (this.versions[key] ?? 0) + 1; }

  /** 2D 貼圖的 mip 範圍 GPU 端複製（色彩或深度模板，同格式） */
  copyLevels(t, dst, first = 0, count = t.mips) {
    const gl = this.gl;
    this._blitFbos ??= [gl.createFramebuffer(), gl.createFramebuffer()];
    const [src, out] = this._blitFbos;
    const attach = t.depth ? (t.stencil ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT) : gl.COLOR_ATTACHMENT0;
    const mask = t.depth ? gl.DEPTH_BUFFER_BIT | (t.stencil ? gl.STENCIL_BUFFER_BIT : 0) : gl.COLOR_BUFFER_BIT;
    this.fullRange(t); this.fullRange(dst);
    const clear = (target) => { for (const p of [gl.COLOR_ATTACHMENT0, gl.DEPTH_STENCIL_ATTACHMENT]) gl.framebufferTexture2D(target, p, gl.TEXTURE_2D, null, 0); }; // 上次可能掛了別種附件（尺寸不同即不完整）
    for (let level = first; level < first + count; level++) {
      const w = Math.max(1, t.w >> level), h = Math.max(1, t.h >> level);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
      clear(gl.READ_FRAMEBUFFER);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, attach, gl.TEXTURE_2D, t.tex, level);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, out);
      clear(gl.DRAW_FRAMEBUFFER);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, attach, gl.TEXTURE_2D, dst.tex, level);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, mask, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  /** 初始快照上傳後留一份 GPU 端原稿；重跑時用複製還原，不必再從 CPU 上傳（只限單層 2D、非壓縮） */
  keepPristine(key) {
    const t = this.tex[key];
    if (!t || t.layers > 1 || t.cube || t.bc || t.compressed || t.structured || !this.written().has(key)) return;
    this.scratch();
    const p = createTexture(this.gl, { w: t.w, h: t.h, fmt: t.fmt, mips: t.mips });
    this.copyLevels(t, p);
    (this.pristine ??= {})[key] = p;
  }

  /** 取樣時限定的 mip 範圍會影響同一貼圖當 RT 的完整性 → 當 RT／複製前恢復全範圍 */
  fullRange(t) {
    if (t.compressed || t.structured) return;
    const gl = this.gl;
    this.scratch();
    gl.bindTexture(t.target, t.tex);
    gl.texParameteri(t.target, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(t.target, gl.TEXTURE_MAX_LEVEL, t.mips - 1);
  }

}
