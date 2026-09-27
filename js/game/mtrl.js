// .mtrl 解析：shader 名、貼圖路徑＋sampler 用途、色表（colorset）、shader 常數。
// 結構對照 Penumbra.GameData Files/MtrlFile.cs（支援 7.0 後 32 列色表）。

export const SAMPLER = {
  diffuse: 0x115306be,
  normal: 0x0c5ec1f1,
  mask: 0x8a4e82b6,
  index: 0x565f8fd8,
  specular: 0x2b99e025,
};
export const CONST_ALPHA_THRESHOLD = 0x29ac0223;

function cstr(bytes, off) {
  let e = off;
  while (e < bytes.length && bytes[e] !== 0) e++;
  return new TextDecoder().decode(bytes.subarray(off, e));
}

export function parseMtrl(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  const dataSetSize = u16(6);
  const stringTableSize = u16(8);
  const shaderNameOffset = u16(10);
  const textureCount = dv.getUint8(12), uvSetCount = dv.getUint8(13), colorSetCount = dv.getUint8(14), additionalSize = dv.getUint8(15);
  let o = 16;
  const texOffsets = [];
  for (let i = 0; i < textureCount; i++) texOffsets.push(u16(o + i * 4));
  o += textureCount * 4 + (uvSetCount + colorSetCount) * 4;
  const strings = bytes.subarray(o, o + stringTableSize);
  o += stringTableSize;
  let flags = 0;
  for (let i = 0; i < Math.min(additionalSize, 4); i++) flags |= dv.getUint8(o + i) << (8 * i);
  o += additionalSize;

  // 色表：寬＝2^(flags>>4 &0xF) 個 vec4、高＝2^(flags>>8 &0xF) 列；0 視為舊制 4×16。
  // 染色表（flags 0x8）緊接在色表後；7.0 新制每列 u32（見 dye.js）。舊制 16×u16 格式 spike 不處理（台服掃描未出現）。
  let table = null;
  let dyeTable = null;
  if (dataSetSize > 0 && flags & 0x4) {
    const logs = (flags >>> 4) & 0xff;
    const width = logs ? 1 << (logs & 0xf) : 4;
    const height = logs ? 1 << (logs >> 4) : 16;
    const bytesLen = width * 4 * height * 2;
    if (bytesLen <= dataSetSize) table = { width, height, data: new Uint16Array(bytes.buffer.slice(bytes.byteOffset + o, bytes.byteOffset + o + bytesLen)) };
    if (table && logs >= 0x50 && flags & 0x8 && bytesLen + height * 4 <= dataSetSize) {
      dyeTable = new Uint32Array(bytes.buffer.slice(bytes.byteOffset + o + bytesLen, bytes.byteOffset + o + bytesLen + height * 4));
    }
  }
  o += dataSetSize;

  const keyCount = u16(o + 2), constCount = u16(o + 4), samplerCount = u16(o + 6);
  // 材質旗標（TexTools EMaterialFlags1）：0x01 隱藏背面、0x10 半透明混合
  const materialFlags = u16(o + 8);
  o += 12;
  const keys = new Map(); // 材質 shader key：類別 CRC → 值 CRC（決定 shpk 內選用哪個著色器變體）
  for (let i = 0; i < keyCount; i++) keys.set(u32(o + i * 8), u32(o + i * 8 + 4));
  o += keyCount * 8;
  const consts = [];
  for (let i = 0; i < constCount; i++) consts.push({ id: u32(o + i * 8), offset: u16(o + i * 8 + 4), size: u16(o + i * 8 + 6) });
  o += constCount * 8;
  const samplers = [];
  for (let i = 0; i < samplerCount; i++) samplers.push({ id: u32(o + i * 12), flags: u32(o + i * 12 + 4), texture: dv.getUint8(o + i * 12 + 8) });
  o += samplerCount * 12;
  const values = o;

  const constants = new Map();
  for (const c of consts) {
    const arr = [];
    for (let k = 0; k < c.size / 4; k++) arr.push(dv.getFloat32(values + c.offset + k * 4, true));
    constants.set(c.id, arr);
  }
  const texturePaths = texOffsets.map((t) => cstr(strings, t));
  // 遊戲著色器重播用：全部 sampler（id、旗標、貼圖路徑）與 shader key（依檔內順序）、常數原始位元組
  const samplerList = samplers.map((s) => ({ ...s, path: texturePaths[s.texture] ?? null }));
  const keyList = [...keys].map(([id, value]) => ({ id, value }));
  const constantBytes = new Map(consts.map((c) => [c.id, bytes.slice(values + c.offset, values + c.offset + c.size)]));
  const textures = {};
  const textureIndex = {}; // 用途 → 材質內貼圖序號（＝遊戲 MaterialResourceHandle.Textures 的索引，匯入遊戲實際載入的貼圖時用）
  for (const s of samplers) {
    const role = Object.keys(SAMPLER).find((k) => SAMPLER[k] === s.id);
    if (role && texturePaths[s.texture]) { textures[role] = texturePaths[s.texture]; textureIndex[role] = s.texture; }
  }
  return { shader: cstr(strings, shaderNameOffset), textures, textureIndex, keys, table, dyeTable, constants, materialFlags, samplerList, keyList, constantBytes, texturePaths };
}
