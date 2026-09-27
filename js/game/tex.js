// .tex 解析：80 byte 標頭＋各 mip 原始資料（遊戲格式，未轉碼）。對照 Lumina TexFile.TexHeader。

export const TEX_FORMAT = {
  0x1130: { name: 'L8', bpp: 8 },
  0x1131: { name: 'A8', bpp: 8 },
  0x1440: { name: 'B4G4R4A4', bpp: 16 },
  0x1441: { name: 'B5G5R5A1', bpp: 16 },
  0x1450: { name: 'B8G8R8A8', bpp: 32 },
  0x1451: { name: 'B8G8R8X8', bpp: 32 },
  0x3420: { name: 'BC1', block: 8 },
  0x3430: { name: 'BC2', block: 16 },
  0x3431: { name: 'BC3', block: 16 },
  0x6120: { name: 'BC4', block: 8 },
  0x6230: { name: 'BC5', block: 16 },
  0x6330: { name: 'BC6H', block: 16 },
  0x6432: { name: 'BC7', block: 16 },
};

export function mipByteSize(fmt, w, h) {
  return fmt.block ? Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * fmt.block : (w * h * fmt.bpp) / 8;
}

/**
 * @returns {{formatId, width, height, depth, arraySize, format, mips: {data, width, height}[]}}；格式不支援時 format＝null、mips 空。
 * 陣列貼圖（TexHeader 0x0F＝ArraySize，如 tile_norm_array 64 層）每個 mip 的 data 依序含全部層。
 */
export function parseTex(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatId = dv.getUint32(4, true);
  const width = dv.getUint16(8, true);
  const height = dv.getUint16(10, true);
  const depth = Math.max(1, dv.getUint16(12, true));
  const mipCount = Math.max(1, dv.getUint8(14) & 0x7f);
  const arraySize = Math.max(1, dv.getUint8(15));
  const fmt = TEX_FORMAT[formatId];
  const mips = [];
  if (fmt) {
    for (let i = 0; i < Math.min(mipCount, 13); i++) {
      const off = dv.getUint32(28 + i * 4, true);
      const w = Math.max(1, width >> i);
      const h = Math.max(1, height >> i);
      const size = mipByteSize(fmt, w, h) * arraySize * Math.max(1, depth >> i);
      if (!off || off + size > bytes.length) break;
      mips.push({ data: bytes.subarray(off, off + size), width: w, height: h });
    }
  }
  return { formatId, width, height, depth, arraySize, format: fmt ? fmt.name : null, mips };
}
