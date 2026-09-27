// 依 manifest 的來源規則，從玩家選取的遊戲檔案重建擷取時使用的原始位元組。
// 快照的 mip 資料出自 .tex；少數 GPU rowPitch／mip 對齊空隙有非零值，僅這些空隙以衍生補丁保存。
import { parseTex, TEX_FORMAT, mipByteSize } from '../game/tex.js';

function decodeBase64(text) {
  const binary = atob(text);
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

async function entryBytes(packs, location) {
  const pack = packs?.[location.category];
  if (!pack) throw new Error(`缺少遊戲資料分類 ${location.category}`);
  const entry = location.indexKey ? pack.entries.get(BigInt(`0x${location.indexKey}`)) : undefined;
  const bytes = location.path ? await pack.read(location.path)
    : entry === undefined ? null : await pack.readEntry(entry);
  if (!bytes) throw new Error(`遊戲資料不存在：${location.path ?? `${location.category}:${location.indexKey}`}`);
  return bytes;
}

export async function rebuildClientBytes(packs, ref) {
  let out;
  if (ref.method === 'mdl-parts') {
    out = new Uint8Array(ref.bytes);
    for (const part of ref.parts) {
      const bytes = await entryBytes(packs, part);
      if (part.sourceOffset + part.length > bytes.length || part.bufferOffset + part.length > out.length) throw new Error('模型組裝區段超出檔案邊界');
      out.set(bytes.subarray(part.sourceOffset, part.sourceOffset + part.length), part.bufferOffset);
    }
  } else {
    const bytes = await entryBytes(packs, ref);
    if (ref.method === 'mdl-section') {
      if (ref.offset + ref.bytes > bytes.length) throw new Error('模型區段超出檔案邊界');
      out = bytes.subarray(ref.offset, ref.offset + ref.bytes);
    } else {
      const tex = parseTex(bytes);
      if (!tex.format) throw new Error('遊戲貼圖格式不支援');
      if (ref.method === 'tex-mips') {
        const size = tex.mips.reduce((n, mip) => n + mip.data.length, 0);
        if (size !== ref.bytes) throw new Error(`貼圖 mip 長度不符：${size} ≠ ${ref.bytes}`);
        out = new Uint8Array(size);
        let at = 0;
        for (const mip of tex.mips) { out.set(mip.data, at); at += mip.data.length; }
      } else if (ref.method === 'tex-rows') {
        out = new Uint8Array(ref.bytes);
        const fmt = TEX_FORMAT[tex.formatId];
        if (!fmt.block) throw new Error('擷取的貼圖列不是區塊壓縮格式');
        for (const [mip, layer, offset, pitch, depthPitch, w, h, depth = 1] of ref.rows) {
          const src = tex.mips[mip];
          const rowBytes = Math.ceil(w / 4) * fmt.block;
          const rowCount = Math.ceil(h / 4);
          const layerBytes = mipByteSize(fmt, w, h);
          if (!src || src.width !== w || src.height !== h || layer >= tex.arraySize || pitch < rowBytes ||
              offset + (depth - 1) * depthPitch + (rowCount - 1) * pitch + rowBytes > out.length) throw new Error('擷取貼圖列不符合遊戲貼圖');
          for (let z = 0; z < depth; z++) for (let y = 0; y < rowCount; y++) {
            const from = (layer * depth + z) * layerBytes + y * rowBytes;
            if (from + rowBytes > src.data.length) throw new Error('遊戲貼圖列超出 mip 邊界');
            out.set(src.data.subarray(from, from + rowBytes), offset + z * depthPitch + y * pitch);
          }
        }
      } else throw new Error(`不支援的遊戲資料取出方式：${ref.method}`);
    }
  }
  for (const [offset, base64] of ref.patches ?? []) {
    const patch = decodeBase64(base64);
    if (offset + patch.length > out.length) throw new Error('擷取對齊補丁超出檔案邊界');
    out.set(patch, offset);
  }
  if (out.length !== ref.bytes) throw new Error(`遊戲資料位元組數不符：${out.length} ≠ ${ref.bytes}`);
  return out;
}

export async function verifiedClientBytes(packs, ref) {
  const bytes = await rebuildClientBytes(packs, ref);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const actual = [...digest].map(x => x.toString(16).padStart(2, '0')).join('');
  if (actual !== ref.sha256) throw new Error(`你的遊戲版本和預覽資料不同（可能是遊戲剛更新、網站還沒跟上）：${ref.path ?? ref.indexKey ?? '組裝模型'}（SHA-256 不符）`);
  return bytes;
}
