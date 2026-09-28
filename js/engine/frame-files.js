// 背景包的網路下載、Cache Storage 預載與虛擬檔位元組。
import { verifiedClientBytes } from './client-files.js';
// 本機 serve.py 不做 HTTP 壓縮；包內 .bin.gz 是原位元組 gzip 封裝，不可當作遊戲原格式直接上傳 GPU。
// DecompressionStream 只在 .gz 檔名使用；瀏覽器若由 HTTP Content-Encoding 先解壓會造成雙重解壓，公開站不得對 .gz 加 Content-Encoding
// （背景資料 Pages 專案以 application/gzip 原位元組提供、不加 Content-Encoding，2026-09-28 實測含 br／gzip 請求）。
export const fetchBytes = async (url) => {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  if (url.endsWith('.gz')) {
    if (r.headers.has('Content-Encoding')) throw new Error(`${url} 已由 HTTP Content-Encoding 解壓，不可再以 DecompressionStream 解壓`);
    return new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
  return new Uint8Array(await r.arrayBuffer());
};
export const textDecoder = new TextDecoder();
async function decodeFile(url, raw) {
  if (!url.endsWith('.gz')) return raw;
  return new Uint8Array(await new Response(new Response(raw).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
/** 以 key 快取 promise；失敗時移除（一次網路失敗不應讓之後每次重跑都沿用同一個 rejected promise） */
export function memo(map, key, make) {
  if (!map.has(key)) map.set(key, make().catch((e) => { map.delete(key); throw e; }));
  return map.get(key);
}

export class FrameFiles {
  /** 檔案大小與路徑由 build-replay-frame.mjs 的 download 清單提供；流式計數的是實際傳輸位元組。
   *  進度含已載好的 manifest（總量＝index.json 的 total、檔案數＝index.json 的 files），背景按鈕與下載面板才對得上。 */
  async prefetchFiles(onProgress, cache, manifest) {
    const files = this.m.download?.files ?? [];
    const total = (this.m.download?.total ?? 0) + manifest.bytes;
    let loaded = manifest.bytes, cachedBytes = manifest.fromCache ? manifest.bytes : 0, doneFiles = 1, next = 0;
    const notify = () => onProgress?.({ loaded, total, doneFiles, files: files.length + 1, cachedBytes });
    notify();
    const one = async ([file, expected]) => {
      const url = this.base + file;
      for (let attempt = 0; attempt < 3; attempt++) {
        let counted = 0, fromCache = false;
        try {
          let response = null;
          if (cache) {
            try { response = await cache.match(url); } catch { /* Cache Storage 暫時不可用。 */ }
            fromCache = !!response;
          }
          if (!response) response = await fetch(url, { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (url.endsWith('.gz') && response.headers.has('Content-Encoding')) throw new Error('gzip 內容被 HTTP 自動解壓');
          const chunks = [], reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            counted += value.byteLength;
            loaded += value.byteLength;
            if (fromCache) cachedBytes += value.byteLength;
            notify();
          }
          if (counted !== expected) throw new Error(`位元組 ${counted} ≠ manifest ${expected}`);
          const raw = chunks.length === 1 ? chunks[0] : new Uint8Array(counted);
          if (chunks.length !== 1) { let at = 0; for (const c of chunks) { raw.set(c, at); at += c.byteLength; } }
          const bytes = await decodeFile(url, raw);
          this.byteCache ??= new Map();
          this.byteCache.set(url, Promise.resolve(bytes));
          if (!fromCache && cache) try { await cache.put(url, new Response(raw)); } catch { /* 寫快取失敗不妨礙顯示。 */ }
          doneFiles++; notify();
          return;
        } catch (e) {
          loaded -= counted;
          if (fromCache) { cachedBytes -= counted; try { await cache?.delete(url); } catch { /* 忽略快取刪除失敗。 */ } }
          notify();
          if (attempt === 2) throw new Error(`${file} 下載失敗（重試 2 次）：${e.message}`);
        }
      }
    };
    // 任一檔最終失敗就整包失敗：其餘管線做完手上那一檔即停，不再開新檔（已下載的檔已進快取，重試時不重抓）
    let failed = false;
    await Promise.all(Array.from({ length: Math.min(6, files.length) }, async () => {
      for (;;) {
        const i = next++;
        if (failed || i >= files.length) break;
        try { await one(files[i]); } catch (e) { failed = true; throw e; }
      }
    }));
  }
  /** 本機遊戲檔與網路包同步準備；每份資料以 SHA-256 核對建置時的原始擷取位元組。 */
  async prefetchClientFiles(onProgress) {
    const files = Object.entries(this.m.clientFiles ?? {});
    const total = files.reduce((n, [, ref]) => n + ref.bytes, 0);
    let loaded = 0, doneFiles = 0, next = 0;
    const notify = () => onProgress?.({ loaded, total, doneFiles, files: files.length });
    notify();
    let failed = false;
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
      for (;;) {
        const at = next++;
        if (failed || at >= files.length) break;
        const [file] = files[at];
        try {
          await this.bytesOf({ file });
          loaded += this.m.clientFiles[file].bytes;
          doneFiles++;
          notify();
        } catch (e) { failed = true; throw e; }
      }
    }));
  }

  /** 驗證工具明確呼叫才載入遊戲快照索引；GameView 正常顯示絕不下載 verification.json／快照。 */
  async loadVerification() {
    this.verification ??= fetch(this.base + 'verification.json', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error(`verification.json ${r.status}`); return r.json(); })
      .then(v => { this.m.snapshots = v.snapshots; return v; });
    return this.verification;
  }

  /** 檔案位元組（同一檔只抓一次；重跑整幀時重傳快照不再走網路） */
  bytesOf(src) {
    const url = src.url ?? this.base + src.file;
    const client = this.m.clientFiles?.[src.file];
    return memo(this.byteCache ??= new Map(), url, () => client
      ? verifiedClientBytes(this.packs, client)
      : fetchBytes(url));
  }

  /** 網頁端產生的內容（換裝的網格、常數緩衝）以虛擬檔名登記，之後和擷取檔走同一條路 */
  provide(file, bytes) {
    this.byteCache ??= new Map();
    this.byteCache.set(this.base + file, Promise.resolve(bytes));
  }
}
