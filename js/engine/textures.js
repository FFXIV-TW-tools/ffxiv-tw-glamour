// 開發用（皮膚試驗・重播）：D3D11 資源快照 ↔ WebGL2 貼圖的共用轉換。
// 快照內容＝各子資源（mip × 陣列層）依序相接，每段帶驅動的 rowPitch（ShaderProbe schema 4 的 subresources；
// schema 3 只有子資源 0）。BGRA 以 RGBA 存（著色器看到的是邏輯通道，上傳時換序）；D3D 的 R24G8（深度在低 24 位元）
// 轉 GL 的 UNSIGNED_INT_24_8（深度在高 24 位元）。

/** DXGI 格式 → GL 儲存格式 */
export const COLOR = {
  28: 'RGBA8', 27: 'RGBA8', 87: 'RGBA8', 88: 'RGBA8', 90: 'RGBA8', 91: 'RGBA8',
  10: 'RGBA16F', 9: 'RGBA16F', 26: 'R11F_G11F_B10F', 61: 'R8', 60: 'R8', 41: 'R32F', 39: 'R32F', 34: 'RG16F', 33: 'RG16F', 2: 'RGBA32F', 1: 'RGBA32F', 65: 'RGBA8',
  62: 'R8UI', // R8_UINT（TSCMAA 邊緣圖；compute 以 usampler2D／uvec4 輸出讀寫）
};
export const DEPTH = { 44: 'DEPTH24_STENCIL8', 45: 'DEPTH24_STENCIL8', 46: 'DEPTH24_STENCIL8', 53: 'DEPTH_COMPONENT16', 55: 'DEPTH_COMPONENT16', 56: 'DEPTH_COMPONENT16' };
export const BC = { 71: 'BC1', 70: 'BC1', 72: 'BC1', 74: 'BC2', 73: 'BC2', 77: 'BC3', 76: 'BC3', 80: 'BC4', 79: 'BC4', 83: 'BC5', 82: 'BC5', 98: 'BC7', 97: 'BC7', 99: 'BC7' };
const BGRA = new Set([87, 88, 90, 91]);
const BC_EXT = {
  BC1: ['WEBGL_compressed_texture_s3tc', 'COMPRESSED_RGBA_S3TC_DXT1_EXT', 8], BC2: ['WEBGL_compressed_texture_s3tc', 'COMPRESSED_RGBA_S3TC_DXT3_EXT', 16],
  BC3: ['WEBGL_compressed_texture_s3tc', 'COMPRESSED_RGBA_S3TC_DXT5_EXT', 16], BC4: ['EXT_texture_compression_rgtc', 'COMPRESSED_RED_RGTC1_EXT', 8],
  BC5: ['EXT_texture_compression_rgtc', 'COMPRESSED_RED_GREEN_RGTC2_EXT', 16], BC7: ['EXT_texture_compression_bptc', 'COMPRESSED_RGBA_BPTC_UNORM_EXT', 16],
};
const BYTES = { RGBA8: 4, RGBA16F: 8, R11F_G11F_B10F: 4, R8: 1, R8UI: 1, R32F: 4, RG16F: 4, RGBA32F: 16, DEPTH24_STENCIL8: 4, DEPTH_COMPONENT16: 2 };

export function half(u) {
  const e = (u >> 10) & 31, m = u & 1023, s = u & 0x8000 ? -1 : 1;
  return s * (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15));
}

/** 快照的子資源清單：[{ mip, slice, offset, rowPitch, depthPitch, w, h, d }]（d＝3D 貼圖該 mip 的深度）；schema 3 只給 rowPitch → 子資源 0 */
export function subresourceList(ref, w, h) {
  if (ref.subresources?.length) return ref.subresources.map(([mip, slice, offset, rowPitch, depthPitch, sw, sh, sd]) => ({ mip, slice, offset, rowPitch, depthPitch, w: sw, h: sh, d: sd ?? 1 }));
  return [{ mip: 0, slice: 0, offset: 0, rowPitch: ref.rowPitch, w, h, d: 1 }];
}

/** 依 D3D 資源描述建 GL 貼圖（mip 數、陣列層數照描述；cube＝6 層當 GL 立方體；volume＝3D 貼圖，layers＝深度）；回傳 { tex, target, internal, w, h, layers, mips, depth, stencil, bc, cube, volume } */
export function createTexture(gl, { w, h, fmt, layers = 1, mips = 1, cube = false, volume = false }) {
  const depth = DEPTH[fmt];
  const bc = BC[fmt];
  let internal = depth ?? COLOR[fmt];
  if (bc) {
    const [extName, key] = BC_EXT[bc];
    const ext = gl.getExtension(extName);
    if (!ext) throw new Error(`瀏覽器不支援 ${bc}`);
    internal = ext[key];
  }
  if (internal === undefined) throw new Error(`未支援格式 ${fmt}`);
  const levels = Math.max(1, mips);
  const target = cube ? gl.TEXTURE_CUBE_MAP : volume ? gl.TEXTURE_3D : layers > 1 ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;
  const tex = gl.createTexture();
  gl.bindTexture(target, tex);
  const glInternal = typeof internal === 'string' ? gl[internal] : internal;
  if (target === gl.TEXTURE_2D_ARRAY || target === gl.TEXTURE_3D) gl.texStorage3D(target, levels, glInternal, w, h, layers);
  else gl.texStorage2D(target, levels, glInternal, w, h);
  gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, levels - 1);
  return { tex, target, internal: bc ?? internal, glInternal, w, h, layers, mips: levels, depth: !!depth, stencil: internal === 'DEPTH24_STENCIL8', bc, fmt, cube, volume };
}

/**
 * 快照位元組 → 貼圖（逐子資源；呼叫端先 bind 到可用的貼圖單元）。
 * replicateLayers：快照只有第 0 層、貼圖卻有多層時複製到全部層（舊快照只存 slice 0；會回傳 true 讓呼叫端記錄）。
 */
export function uploadSnapshot(gl, t, bytes, subs, { replicateLayers = false } = {}) {
  gl.bindTexture(t.target, t.tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const slicesPresent = new Set(subs.map(s => s.slice));
  const replicate = replicateLayers && t.layers > 1 && !t.cube && !t.volume && slicesPresent.size === 1;
  // 立方體：第 l 層＝面 l（D3D 與 GL 面序相同）
  const faceTarget = (l) => (t.cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + l : t.target);
  const array = t.target === gl.TEXTURE_2D_ARRAY;
  for (const s of subs) {
    if (s.mip >= t.mips) continue;
    const layers = replicate ? [...Array(t.layers).keys()] : [s.slice];
    if (t.bc) {
      const bpb = BC_EXT[t.bc][2];
      const bw = Math.max(1, Math.ceil(s.w / 4)), bh = Math.max(1, Math.ceil(s.h / 4));
      const packed = new Uint8Array(bw * bh * bpb);
      for (let y = 0; y < bh; y++) packed.set(bytes.subarray(s.offset + y * s.rowPitch, s.offset + y * s.rowPitch + bw * bpb), y * bw * bpb);
      for (const l of layers) {
        if (array) gl.compressedTexSubImage3D(t.target, s.mip, 0, 0, l, s.w, s.h, 1, t.glInternal, packed);
        else gl.compressedTexSubImage2D(faceTarget(l), s.mip, 0, 0, s.w, s.h, t.glInternal, packed);
      }
      continue;
    }
    const bpp = BYTES[t.internal];
    // 3D：該 mip 的 d 個切片（第 z 片起點＝offset＋z·depthPitch）接成一塊，一次 texSubImage3D
    const planes = t.volume ? s.d : 1;
    const rowBytes = s.w * (t.fmt === 65 ? 1 : bpp);
    const src = new Uint8Array(rowBytes * s.h * planes);
    for (let z = 0; z < planes; z++) {
      for (let y = 0; y < s.h; y++) {
        const at = s.offset + z * (s.depthPitch ?? 0) + y * s.rowPitch;
        src.set(bytes.subarray(at, at + rowBytes), (z * s.h + y) * rowBytes);
      }
    }
    let layer = src;
    if (t.fmt === 65) { // A8 → RGBA（rgb＝0）
      layer = new Uint8Array(s.w * s.h * 4);
      for (let i = 0; i < s.w * s.h; i++) layer[i * 4 + 3] = src[i];
    } else if (BGRA.has(t.fmt)) for (let i = 0; i < layer.length; i += 4) { const b = layer[i]; layer[i] = layer[i + 2]; layer[i + 2] = b; }
    const [format, type, view] = {
      RGBA8: [gl.RGBA, gl.UNSIGNED_BYTE, (b) => b], RGBA16F: [gl.RGBA, gl.HALF_FLOAT, (b) => new Uint16Array(b.buffer)],
      R11F_G11F_B10F: [gl.RGB, gl.UNSIGNED_INT_10F_11F_11F_REV, (b) => new Uint32Array(b.buffer)], R8: [gl.RED, gl.UNSIGNED_BYTE, (b) => b], R8UI: [gl.RED_INTEGER, gl.UNSIGNED_BYTE, (b) => b],
      R32F: [gl.RED, gl.FLOAT, (b) => new Float32Array(b.buffer)], RG16F: [gl.RG, gl.HALF_FLOAT, (b) => new Uint16Array(b.buffer)],
      RGBA32F: [gl.RGBA, gl.FLOAT, (b) => new Float32Array(b.buffer)],
      DEPTH24_STENCIL8: [gl.DEPTH_STENCIL, gl.UNSIGNED_INT_24_8, (b) => { const u = new Uint32Array(b.buffer); for (let i = 0; i < u.length; i++) u[i] = ((u[i] << 8) | (u[i] >>> 24)) >>> 0; return u; }],
      DEPTH_COMPONENT16: [gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, (b) => new Uint16Array(b.buffer)],
    }[t.internal];
    const data = view(layer);
    if (t.volume) { gl.texSubImage3D(t.target, s.mip, 0, 0, 0, s.w, s.h, planes, format, type, data); continue; }
    for (const l of layers) {
      if (array) gl.texSubImage3D(t.target, s.mip, 0, 0, l, s.w, s.h, 1, format, type, data);
      else gl.texSubImage2D(faceTarget(l), s.mip, 0, 0, s.w, s.h, format, type, data);
    }
  }
  return replicate;
}

/** D3D 未綁的 SRV 讀到 0：依著色器宣告的型別（dxbc2glsl 的 binding.type）給 1×1 全零貼圖（每個 context 各型別一份；呼叫端先選好貼圖單元） */
const nulls = new WeakMap();
export function nullTexture(gl, type) {
  const kind = type === 'structured' ? 'structured' : type === 'texturecube' ? 'cube' : /array/.test(type) ? 'array' : type === 'texture3d' ? '3d' : '2d';
  if (!nulls.has(gl)) nulls.set(gl, {});
  const cache = nulls.get(gl);
  if (cache[kind]) return cache[kind];
  const target = { structured: gl.TEXTURE_2D, cube: gl.TEXTURE_CUBE_MAP, array: gl.TEXTURE_2D_ARRAY, '3d': gl.TEXTURE_3D, '2d': gl.TEXTURE_2D }[kind];
  const tex = gl.createTexture();
  gl.bindTexture(target, tex);
  const structured = kind === 'structured', volume = kind === 'array' || kind === '3d';
  const internal = structured ? gl.R32UI : gl.RGBA8;
  if (volume) gl.texStorage3D(target, 1, internal, 1, 1, 1);
  else gl.texStorage2D(target, 1, internal, 1, 1);
  const zero = structured ? new Uint32Array(1) : new Uint8Array(4);
  const [format, typ] = structured ? [gl.RED_INTEGER, gl.UNSIGNED_INT] : [gl.RGBA, gl.UNSIGNED_BYTE];
  if (kind === 'cube') for (let f = 0; f < 6; f++) gl.texSubImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, 0, 0, 1, 1, format, typ, zero);
  else if (volume) gl.texSubImage3D(target, 0, 0, 0, 0, 1, 1, 1, format, typ, zero);
  else gl.texSubImage2D(target, 0, 0, 0, 1, 1, format, typ, zero);
  return (cache[kind] = { tex, target });
}

/** 快照的一個子資源 → Float32 RGBA（UNORM 以 0..1；R8_UINT 為整數值；深度 R24G8：r＝深度、g＝模板；D16：r＝深度）。3D 的第 z 片：s.offset 加 z·depthPitch */
export function decodeSnapshot(fmt, bytes, s) {
  const { w, h } = s;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const px = new Float32Array(w * h * 4);
  const f11 = (v) => { const e = v >> 6, m = v & 63; return e === 0 ? m * 2 ** -20 : (1 + m / 64) * 2 ** (e - 15); };
  const f10 = (v) => { const e = v >> 5, m = v & 31; return e === 0 ? m * 2 ** -19 : (1 + m / 32) * 2 ** (e - 15); };
  for (let y = 0; y < h; y++) {
    const o = s.offset + y * s.rowPitch;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (BGRA.has(fmt)) { const q = o + x * 4; px[p] = bytes[q + 2] / 255; px[p + 1] = bytes[q + 1] / 255; px[p + 2] = bytes[q] / 255; px[p + 3] = bytes[q + 3] / 255; }
      else if (fmt === 28 || fmt === 27) { const q = o + x * 4; for (let c = 0; c < 4; c++) px[p + c] = bytes[q + c] / 255; }
      else if (fmt === 10 || fmt === 9) { const q = o + x * 8; for (let c = 0; c < 4; c++) px[p + c] = half(dv.getUint16(q + c * 2, true)); }
      else if (fmt === 34 || fmt === 33) { const q = o + x * 4; px[p] = half(dv.getUint16(q, true)); px[p + 1] = half(dv.getUint16(q + 2, true)); }
      else if (fmt === 41 || fmt === 39) { px[p] = dv.getFloat32(o + x * 4, true); }
      else if (fmt === 2 || fmt === 1) { for (let c = 0; c < 4; c++) px[p + c] = dv.getFloat32(o + x * 16 + c * 4, true); }
      else if (fmt === 26) { const u = dv.getUint32(o + x * 4, true); px[p] = f11(u & 0x7ff); px[p + 1] = f11((u >>> 11) & 0x7ff); px[p + 2] = f10(u >>> 22); px[p + 3] = 1; }
      else if (fmt === 61 || fmt === 60) { px[p] = bytes[o + x] / 255; }
      else if (fmt === 62) { px[p] = bytes[o + x]; }
      else if (fmt === 65) { px[p + 3] = bytes[o + x] / 255; }
      else if (fmt === 44 || fmt === 45) { const u = dv.getUint32(o + x * 4, true); px[p] = (u & 0xffffff) / 0xffffff; px[p + 1] = u >>> 24; }
      else if (fmt === 53 || fmt === 55 || fmt === 56) { px[p] = dv.getUint16(o + x * 2, true) / 65535; }
    }
  }
  return { w, h, px };
}
