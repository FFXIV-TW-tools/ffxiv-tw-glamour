// 讀玩家本機的 sqpack（chara 分類 040000；背景圖另用 ui 分類 060000）。資料來源是 Blob：
// 瀏覽器＝使用者選的 File；Node 測試＝fs.openAsBlob。只 slice 需要的區段，不整檔讀入。
// 格式對照 Lumina SqPackStream / SqPackIndex（NotAdam/Lumina master）。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const utf8 = new TextEncoder();

/** SE 的路徑雜湊：標準 CRC32 但不做最終 XOR（＝Lumina Crc32.Get）。 */
export function sqpackHash(text) {
  let crc = 0xffffffff;
  for (const b of utf8.encode(text.toLowerCase())) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

/**
 * index1 的鍵＝(資料夾雜湊 << 32) | 檔名雜湊。不用 index2（整路徑 32-bit 雜湊）：
 * 2026-09-25 實測台服 040000.index2 有 9 筆 synonym（雜湊碰撞）、index1 為 0；Lumina 也優先用 index1。
 */
export function indexKey(path) {
  const cut = path.lastIndexOf('/');
  return (BigInt(sqpackHash(path.slice(0, cut))) << 32n) | BigInt(sqpackHash(path.slice(cut + 1)));
}

async function slice(blob, start, end) {
  return new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer());
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

const UNCOMPRESSED = 32000;

/** 解一個資料區塊（16 byte 標頭＋資料），寫到 out[outPos]，回傳解出的長度。 */
async function readBlock(buf, pos, out, outPos) {
  const dv = new DataView(buf.buffer, buf.byteOffset + pos, 16);
  const compressed = dv.getUint32(8, true);
  const size = dv.getUint32(12, true);
  const data = buf.subarray(pos + 16, pos + 16 + (compressed === UNCOMPRESSED ? size : compressed));
  const plain = compressed === UNCOMPRESSED ? data : await inflateRaw(data);
  if (plain.length !== size) throw new Error(`sqpack 區塊長度不符：${plain.length} ≠ ${size}`);
  out.set(plain, outPos);
  return size;
}

export class SqPack {
  /** @param {Blob} index 040000.win32.index  @param {Blob[]} dats 依編號排列的 040000.win32.datN */
  constructor(index, dats) {
    this.index = index;
    this.dats = dats;
    this.entries = null;
  }

  async init() {
    const head = await slice(this.index, 0, 0x800);
    const hv = new DataView(head.buffer);
    const headerSize = hv.getUint32(0x0c, true);
    const dataOffset = hv.getUint32(headerSize + 8, true);
    const dataSize = hv.getUint32(headerSize + 12, true);
    const table = await slice(this.index, dataOffset, dataOffset + dataSize);
    const tv = new DataView(table.buffer);
    this.entries = new Map();
    for (let o = 0; o + 16 <= table.length; o += 16) this.entries.set(tv.getBigUint64(o, true), tv.getUint32(o + 8, true));
    return this.entries.size;
  }

  has(path) {
    return this.entries.has(indexKey(path));
  }

  /** @returns {Promise<Uint8Array|null>} 解壓後的檔案內容；不存在回 null */
  async read(path) {
    const data = this.entries.get(indexKey(path));
    if (data === undefined) return null;
    if (data & 1) throw new Error(`索引雜湊碰撞（synonym），spike 未處理：${path}`);
    return this.readEntry(data);
  }

  /** 依索引項目值讀檔（離線掃描用：不知道路徑時走 entries 逐一讀）。 */
  async readEntry(data) {
    if (data & 1) return null;
    const dat = this.dats[(data & 0b1110) >>> 1];
    if (!dat) throw new Error(`缺 dat${(data & 0b1110) >>> 1}`);
    const base = ((data & ~0xf) >>> 0) * 8;
    const first = await slice(dat, base, base + 24);
    const fv = new DataView(first.buffer);
    const headerSize = fv.getUint32(0, true);
    const type = fv.getUint32(4, true);
    const rawSize = fv.getUint32(8, true);
    const header = await slice(dat, base, base + headerSize);
    const hv = new DataView(header.buffer);
    const out = new Uint8Array(rawSize);
    const bodyStart = base + headerSize;
    if (type === 2) await this.#readStandard(dat, hv, bodyStart, out);
    else if (type === 3) await this.#readModel(dat, hv, bodyStart, out);
    else if (type === 4) await this.#readTexture(dat, hv, bodyStart, out);
    else return null;
    return out;
  }

  async #readStandard(dat, hv, bodyStart, out) {
    const count = hv.getUint32(20, true);
    const blocks = [];
    let end = 0;
    for (let i = 0; i < count; i++) {
      const o = 24 + i * 8;
      const off = hv.getUint32(o, true);
      blocks.push(off);
      end = Math.max(end, off + hv.getUint16(o + 4, true));
    }
    const body = await slice(dat, bodyStart, bodyStart + end + 256);
    let outPos = 0;
    for (const off of blocks) outPos += await readBlock(body, off, out, outPos);
  }

  async #readTexture(dat, hv, bodyStart, out) {
    const lodCount = hv.getUint32(20, true);
    const lods = [];
    let end = 0;
    for (let i = 0; i < lodCount; i++) {
      const o = 24 + i * 20;
      const lod = { offset: hv.getUint32(o, true), size: hv.getUint32(o + 4, true), count: hv.getUint32(o + 16, true) };
      lods.push(lod);
      end = Math.max(end, lod.offset + lod.size);
    }
    let sizePos = 24 + lodCount * 20;
    const texHeaderLen = lods[0].offset;
    const body = await slice(dat, bodyStart, bodyStart + end + 256);
    out.set(body.subarray(0, texHeaderLen), 0);
    let outPos = texHeaderLen;
    for (const lod of lods) {
      let running = lod.offset;
      for (let j = 0; j < lod.count; j++) {
        outPos += await readBlock(body, running, out, outPos);
        running += hv.getUint16(sizePos, true);
        sizePos += 2;
      }
    }
  }

  async #readModel(dat, hv, bodyStart, out) {
    const u32 = (o) => hv.getUint32(o, true);
    const u16 = (o) => hv.getUint16(o, true);
    const mb = {
      version: u32(20),
      stackOffset: u32(112), runtimeOffset: u32(116),
      vertexOffset: [u32(120), u32(124), u32(128)],
      stackNum: u16(178), runtimeNum: u16(180),
      vertexNum: [u16(182), u16(184), u16(186)],
      edgeNum: [u16(188), u16(190), u16(192)],
      indexNum: [u16(194), u16(196), u16(198)],
      vdeclNum: u16(200), materialNum: u16(202),
      numLods: hv.getUint8(204), streaming: hv.getUint8(205), edge: hv.getUint8(206),
    };
    let total = mb.stackNum + mb.runtimeNum;
    for (let i = 0; i < 3; i++) total += mb.vertexNum[i] + mb.edgeNum[i] + mb.indexNum[i];
    const sizes = [];
    for (let i = 0; i < total; i++) sizes.push(u16(208 + i * 2));

    // 先模擬讀取順序算出每個區塊位置（Lumina：index 區段不重新 seek，接在前一段之後）
    const plan = []; // {pos, section, lod}
    let pos = 0;
    let cur = 0;
    const run = (count, section, lod) => {
      for (let j = 0; j < count; j++) {
        plan.push({ pos, section, lod });
        pos += sizes[cur++];
      }
    };
    pos = mb.stackOffset; run(mb.stackNum, 'stack');
    pos = mb.runtimeOffset; run(mb.runtimeNum, 'runtime');
    for (let i = 0; i < 3; i++) {
      if (mb.vertexNum[i]) { pos = mb.vertexOffset[i]; run(mb.vertexNum[i], 'vertex', i); }
      if (mb.edgeNum[i]) run(mb.edgeNum[i], 'edge', i);
      if (mb.indexNum[i]) run(mb.indexNum[i], 'index', i);
    }
    const end = Math.max(...plan.map((p, k) => p.pos + sizes[k]));
    const body = await slice(dat, bodyStart, bodyStart + end + 256);

    let outPos = 0x44;
    const secStart = {};
    const secSize = {};
    for (const p of plan) {
      const key = p.lod === undefined ? p.section : `${p.section}${p.lod}`;
      if (secStart[key] === undefined) { secStart[key] = outPos; secSize[key] = 0; }
      const n = await readBlock(body, p.pos, out, outPos);
      outPos += n;
      secSize[key] += n;
    }
    const vOff = [0, 0, 0], iOff = [0, 0, 0], vSize = [0, 0, 0], iSize = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      if (mb.vertexNum[i]) {
        const s = secStart[`vertex${i}`];
        vOff[i] = i === 0 || s !== vOff[i - 1] ? s : 0;
        vSize[i] = secSize[`vertex${i}`];
      }
      if (mb.indexNum[i]) {
        const s = secStart[`index${i}`];
        iOff[i] = i === 0 || s !== iOff[i - 1] ? s : 0;
        iSize[i] = secSize[`index${i}`];
      }
    }
    const ov = new DataView(out.buffer);
    ov.setUint32(0, mb.version, true);
    ov.setUint32(4, secSize.stack ?? 0, true);
    ov.setUint32(8, secSize.runtime ?? 0, true);
    ov.setUint16(12, mb.vdeclNum, true);
    ov.setUint16(14, mb.materialNum, true);
    for (let i = 0; i < 3; i++) {
      ov.setUint32(16 + i * 4, vOff[i], true);
      ov.setUint32(28 + i * 4, iOff[i], true);
      ov.setUint32(40 + i * 4, vSize[i], true);
      ov.setUint32(52 + i * 4, iSize[i], true);
    }
    ov.setUint8(64, mb.numLods);
    ov.setUint8(65, mb.streaming);
    ov.setUint8(66, mb.edge);
    ov.setUint8(67, 0);
  }
}
