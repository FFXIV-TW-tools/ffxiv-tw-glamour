// 染色：解析染色模板檔（.stm）並把染劑值寫進材質色表。對照 Penumbra.GameData
// StmFile / StmFile.StainingTemplateEntry / ColorDyeTableRow / ColorTableRow.ApplyDye。
//
// 模板檔：chara/base_material/stainingtemplate.stm（舊制，key 100–612，characterlegacy 用）
//         chara/base_material/stainingtemplate_gud.stm（7.0，key 1100–1612，character 用）
// 色表每列 32 個 half；染色表每列 u32：bit0–11 哪些欄位可染、bit16–26 模板編號、bit27–28 用第幾格染劑。

export const STM_LEGACY = 'chara/base_material/stainingtemplate.stm';
export const STM_GUD = 'chara/base_material/stainingtemplate_gud.stm';
const STAINS = 254;

/** @returns {{ legacy: boolean, get(template, stainId): Uint16Array|null }} 回傳整包 half（顏色 3×3、再來純量） */
export function parseStm(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0, true) !== 0x534d) throw new Error('STM magic 不符');
  const version = dv.getUint16(2, true);
  const n = dv.getUint16(4, true);
  let colors = bytes[6], scalars = bytes[7];
  if (version === 0x0101) { colors = 3; scalars = 2; }
  const dataStart = 8 + n * 8;
  const entries = new Map();
  for (let i = 0; i < n; i++) {
    const key = dv.getUint32(8 + i * 4, true);
    const start = dataStart + dv.getUint32(8 + n * 4 + i * 4, true) * 2;
    const end = i + 1 < n ? dataStart + dv.getUint32(8 + n * 4 + (i + 1) * 4, true) * 2 : bytes.length;
    entries.set(key, { start, end });
  }
  const cache = new Map();
  const decode = (key) => {
    const e = entries.get(key);
    if (!e) return null;
    const cols = colors + scalars;
    const arrays = [];
    let last = 0;
    let p = e.start + cols * 2;
    for (let c = 0; c < cols; c++) {
      const endByte = dv.getUint16(e.start + c * 2, true) * 2;
      const len = endByte - last;
      last = endByte;
      arrays.push({ start: p, len, elem: c < colors ? 3 : 1 });
      p += len;
    }
    return arrays;
  };
  // 取第 idx（0 起算）個染劑在某一欄的值，寫進 out[at..]
  const readColumn = (col, idx, out, at) => {
    const count = col.len / (col.elem * 2);
    let src = -1;
    if (count === 0) src = -1;
    else if (count === 1) src = col.start;
    else if (count === STAINS) src = col.start + idx * col.elem * 2;
    else {
      const values = (col.len - STAINS) / (col.elem * 2);
      const indexBase = col.start + values * col.elem * 2;
      // 索引表第一個 byte 是 0xFF 標記，實際第 i 個染劑的索引在 indexBase+1+i；最後一格固定 0
      const vi = idx < STAINS - 1 ? bytes[indexBase + 1 + idx] : 0;
      src = vi > 0 && vi <= values ? col.start + (vi - 1) * col.elem * 2 : -1;
    }
    for (let k = 0; k < col.elem; k++) out[at + k] = src < 0 ? 0 : dv.getUint16(src + k * 2, true);
  };
  return {
    legacy: version === 0x0101,
    get(template, stainId) {
      if (stainId < 1 || stainId > STAINS) return null;
      if (!cache.has(template)) cache.set(template, decode(template));
      const arrays = cache.get(template);
      if (!arrays) return null;
      const out = new Uint16Array(colors * 3 + scalars);
      let at = 0;
      for (const col of arrays) { readColumn(col, stainId - 1, out, at); at += col.elem; }
      return out;
    },
  };
}

// 7.0 染劑包：diffuse(0-2) specular(3-5) emissive(6-8) exposure metalness roughness sheenRate sheenTint sheenAperture anisotropy sphereIndex sphereMask
// 對應色表列的 half 位置（ColorTableRow）
const GUD_FIELDS = [
  [0x001, [0, 1, 2], [0, 1, 2]], [0x002, [3, 4, 5], [4, 5, 6]], [0x004, [6, 7, 8], [8, 9, 10]],
  [0x008, [9], [11]], [0x010, [10], [18]], [0x020, [11], [16]], [0x040, [12], [12]], [0x080, [13], [13]],
  [0x100, [14], [14]], [0x200, [15], [19]], [0x400, [16], [27]], [0x800, [17], [21]],
];
// 舊制染劑包：diffuse specular emissive shininess specularMask；以舊制解讀寫回（shininess→第 3 格、specularMask→第 7 格）
const LEGACY_FIELDS = [
  [0x001, [0, 1, 2], [0, 1, 2]], [0x002, [3, 4, 5], [4, 5, 6]], [0x004, [6, 7, 8], [8, 9, 10]],
  [0x008, [9], [3]], [0x010, [10], [7]],
];

/**
 * @param {Uint16Array} table 色表 half（每列 rowHalfs 個）
 * @param {Uint32Array} dyeTable 每列染色設定
 * @param {[number, number]} stains 兩格染劑 id（0＝不染）
 * @param {{legacy, get}} stm 依 shader 選好的模板檔
 * @returns {Uint16Array} 套用後的新色表（不改原陣列）
 */
export function applyDye(table, rowHalfs, dyeTable, stains, stm) {
  const out = table.slice();
  const fields = stm.legacy ? LEGACY_FIELDS : GUD_FIELDS;
  for (let r = 0; r < dyeTable.length; r++) {
    const d = dyeTable[r];
    const stainId = stains[(d >>> 27) & 3] ?? 0;
    if (!stainId) continue;
    const pack = stm.get((d >>> 16) & 0x7ff, stainId);
    if (!pack) continue;
    for (const [bit, from, to] of fields) {
      if (!(d & bit)) continue;
      if (bit === 0x002 && !pack[3] && !pack[4] && !pack[5]) continue; // 染劑沒給高光色就保留原值
      for (let k = 0; k < from.length; k++) out[r * rowHalfs + to[k]] = pack[from[k]];
    }
  }
  return out;
}
