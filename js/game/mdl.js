// .mdl 解析（畫面需要的部分：頂點宣告、字串、LOD0 網格、子網格屬性、材質名、骨骼名／骨骼表、蒙皮權重）。
// 結構對照 Lumina MdlFile / MdlStructs；骨骼表 v6 格式對照 Penumbra.GameData（Lumina 7.6.1 讀 7.x 模型會在此拋例外）。

const USAGE = { position: 0, blendWeights: 1, blendIndices: 2, normal: 3, uv: 4 };

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** 蒙皮權重／骨骼索引元素的 byte 數：UByte4(5)、NByte4(8)、UShort2(16)＝4；UShort4(17)＝8（7.x 八骨影響，逐 byte 解讀）。 */
const BLEND_BYTES = { 5: 4, 8: 4, 16: 4, 17: 8 };

/** 依頂點元素型別讀成 [x,y,z,w]；型別碼同 Lumina Vertex.VertexType。 */
function readElement(dv, o, type) {
  switch (type) {
    case 1: return [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), 0, 0];
    case 2: return [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), 1];
    case 3: return [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)];
    case 8: return [0, 1, 2, 3].map((i) => dv.getUint8(o + i) / 255);
    case 13: return [halfToFloat(dv.getUint16(o, true)), halfToFloat(dv.getUint16(o + 2, true)), 0, 0];
    case 14: return [0, 2, 4, 6].map((i) => halfToFloat(dv.getUint16(o + i, true)));
    default: throw new Error(`未支援的頂點型別 ${type}`);
  }
}

function cstr(bytes, off) {
  let e = off;
  while (e < bytes.length && bytes[e] !== 0) e++;
  return new TextDecoder().decode(bytes.subarray(off, e));
}

export function parseMdl(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  const vertexOffset = [u32(16), u32(20), u32(24)];
  const indexOffset = [u32(28), u32(32), u32(36)];
  const vdeclCount = u16(12);

  let o = 0x44;
  const decls = [];
  for (let d = 0; d < vdeclCount; d++) {
    const elems = [];
    for (let e = 0; e < 17; e++) {
      const p = o + e * 8;
      const stream = dv.getUint8(p);
      if (stream === 255) break;
      elems.push({ stream, offset: dv.getUint8(p + 1), type: dv.getUint8(p + 2), usage: dv.getUint8(p + 3), usageIndex: dv.getUint8(p + 4) }); // Penumbra MdlStructs.VertexElement：Stream, Offset, Type, Usage, UsageIndex
    }
    decls.push(elems);
    o += 17 * 8;
  }

  o += 4; // StringCount u16 + padding u16
  const stringSize = u32(o); o += 4;
  const strings = bytes.subarray(o, o + stringSize); o += stringSize;

  const h = o; // ModelHeader 56 bytes
  const meshCount = u16(h + 4), attributeCount = u16(h + 6), submeshCount = u16(h + 8), materialCount = u16(h + 10);
  const boneCount = u16(h + 12), boneTableCount = u16(h + 14);
  const elementIdCount = u16(h + 24), terrainShadowMeshCount = dv.getUint8(h + 26), flags2 = dv.getUint8(h + 27);
  const terrainShadowSubmeshCount = u16(h + 38);
  o += 56;
  o += elementIdCount * 32;
  const lod0 = { meshIndex: u16(o), meshCount: u16(o + 2) };
  o += 3 * 60;
  if (flags2 & 0x10) o += 3 * 40;

  const meshes = [];
  for (let i = 0; i < meshCount; i++) {
    const p = o + i * 36;
    meshes.push({
      vertexCount: u16(p), indexCount: u32(p + 4), materialIndex: u16(p + 8),
      submeshIndex: u16(p + 10), submeshCount: u16(p + 12), startIndex: u32(p + 16),
      vbOffset: [u32(p + 20), u32(p + 24), u32(p + 28)],
      stride: [dv.getUint8(p + 32), dv.getUint8(p + 33), dv.getUint8(p + 34)],
      boneTableIndex: u16(p + 14),
    });
  }
  o += meshCount * 36;
  const attributes = [];
  for (let i = 0; i < attributeCount; i++) attributes.push(cstr(strings, u32(o + i * 4)));
  o += attributeCount * 4;
  o += terrainShadowMeshCount * 20;
  const submeshes = [];
  for (let i = 0; i < submeshCount; i++) {
    const p = o + i * 16;
    submeshes.push({ indexOffset: u32(p), indexCount: u32(p + 4), attributeMask: u32(p + 8) });
  }
  o += submeshCount * 16;
  o += terrainShadowSubmeshCount * 12;
  const materials = [];
  for (let i = 0; i < materialCount; i++) materials.push(cstr(strings, u32(o + i * 4)));
  o += materialCount * 4;
  const boneNames = [];
  for (let i = 0; i < boneCount; i++) boneNames.push(cstr(strings, u32(o + i * 4)));
  o += boneCount * 4;
  // 骨骼表：v5 每張固定 64 個 u16＋u32 數量；v6（7.x）是 (u16 offset, u16 size) 表頭、資料在 表頭位置＋offset×4（Penumbra BoneTableStruct.ReadV6）
  const boneTables = [];
  const v6 = u32(0) === 0x01000006;
  for (let i = 0; i < boneTableCount; i++) {
    const ids = [];
    if (v6) {
      const p = o + i * 4;
      const start = p + u16(p) * 4;
      for (let k = 0; k < u16(p + 2); k++) ids.push(u16(start + k * 2));
    } else {
      const p = o + i * 132;
      for (let k = 0; k < u32(p + 128); k++) ids.push(u16(p + k * 2));
    }
    boneTables.push(ids.map((id) => boneNames[id]));
  }
  o += v6 ? boneTableCount * 4 + u16(h + 44) * 2 : boneTableCount * 132;

  // 形態鍵（shape）：每個 shape 列出各 LOD 的 shapeMesh 範圍；shapeMesh 以 meshIndexOffset（＝網格 startIndex）
  // 對應網格，其 values 是（索引位置, 替換頂點）——套用時把該位置的索引換成新頂點（Lumina/Penumbra ShapeStruct）
  const shapeCount = u16(h + 16), shapeMeshCount = u16(h + 18), shapeValueCount = u16(h + 20);
  const shapes = [];
  for (let i = 0; i < shapeCount; i++) {
    const p = o + i * 16;
    shapes.push({ name: cstr(strings, u32(p)), start: u16(p + 4), count: u16(p + 10) });
  }
  o += shapeCount * 16;
  const shapeMeshes = [];
  for (let i = 0; i < shapeMeshCount; i++) {
    const p = o + i * 12;
    shapeMeshes.push({ meshStart: u32(p), valueCount: u32(p + 4), valueOffset: u32(p + 8) });
  }
  o += shapeMeshCount * 12;
  const shapeValues = new Uint16Array(bytes.buffer.slice(bytes.byteOffset + o, bytes.byteOffset + o + shapeValueCount * 4));
  const out = [];
  for (let mi = lod0.meshIndex; mi < lod0.meshIndex + lod0.meshCount; mi++) {
    const m = meshes[mi];
    const n = m.vertexCount;
    const position = new Float32Array(n * 3);
    const normal = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const uv2 = new Float32Array(n * 2); // UV 元素為 4 分量時的後半（第二組 UV）
    const blend = { weights: null, indices: null, width: 0 };
    for (const el of decls[mi]) {
      const base = vertexOffset[0] + m.vbOffset[el.stream];
      if (el.usage === USAGE.blendWeights || el.usage === USAGE.blendIndices) {
        const k = BLEND_BYTES[el.type];
        if (!k) throw new Error(`未支援的蒙皮元素型別 ${el.type}`);
        const arr = new Uint8Array(n * k);
        for (let v = 0; v < n; v++) arr.set(bytes.subarray(base + v * m.stride[el.stream] + el.offset, base + v * m.stride[el.stream] + el.offset + k), v * k);
        blend[el.usage === USAGE.blendWeights ? 'weights' : 'indices'] = arr;
        blend.width = Math.max(blend.width, k);
        continue;
      }
      // UV 只取 usageIndex 0（遊戲 TEXCOORD0）；例：e0239_dwn m0 另有 usageIndex 1 的 half2（TEXCOORD1），不可蓋掉 TEXCOORD0
      const target = el.usage === USAGE.position ? position : el.usage === USAGE.normal ? normal : el.usage === USAGE.uv && !el.usageIndex ? uv : null;
      if (!target) continue;
      const width = target === uv ? 2 : 3;
      for (let v = 0; v < n; v++) {
        const val = readElement(dv, base + v * m.stride[el.stream] + el.offset, el.type);
        for (let c = 0; c < width; c++) target[v * width + c] = val[c];
        if (target === uv) { uv2[v * 2] = val[2]; uv2[v * 2 + 1] = val[3]; }
      }
    }
    const indices = new Uint16Array(bytes.buffer.slice(
      bytes.byteOffset + indexOffset[0] + m.startIndex * 2,
      bytes.byteOffset + indexOffset[0] + (m.startIndex + m.indexCount) * 2));
    const subs = submeshes.slice(m.submeshIndex, m.submeshIndex + m.submeshCount).map((s) => ({
      start: s.indexOffset - m.startIndex,
      count: s.indexCount,
      attributes: attributes.filter((_, bit) => s.attributeMask & (1 << bit)),
    }));
    const bones = boneTables[m.boneTableIndex] ?? null;
    const meshShapes = new Map();
    for (const s of shapes) {
      for (const sm of shapeMeshes.slice(s.start, s.start + s.count)) {
        if (sm.meshStart !== m.startIndex) continue;
        const pairs = shapeValues.slice(sm.valueOffset * 2, (sm.valueOffset + sm.valueCount) * 2);
        meshShapes.set(s.name, pairs);
      }
    }
    // raw：遊戲原樣的頂點串（宣告＋每串位元組），供直接餵遊戲的頂點著色器（網頁重播遊戲管線用）；
    // vbOffset／startIndex＝此網格在整個模型頂點緩衝／索引緩衝中的位置（對擷取繪圖的頂點緩衝位移用）
    const raw = {
      decl: decls[mi], stride: m.stride, vertexCount: n, vbOffset: m.vbOffset, startIndex: m.startIndex,
      streams: m.stride.map((s, k) => (s ? bytes.subarray(vertexOffset[0] + m.vbOffset[k], vertexOffset[0] + m.vbOffset[k] + s * n) : null)),
    };
    out.push({ material: materials[m.materialIndex], materialIndex: m.materialIndex, position, normal, uv, uv2, indices, submeshes: subs, blend, bones, shapes: meshShapes, raw });
  }
  return { materials, attributes, meshes: out };
}
