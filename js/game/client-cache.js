// 玩家選取的檔案只在此瀏覽器逐項留存；以遊戲版本隔離，沒有任何網路上傳。
import { REQUIRED_PACKS } from './client-packs.js';

const DB_NAME = 'glamour-client-files';
export const CLIENT_CACHE_CAP = 450_000_000;
const FACT = 'fact', FILE = 'file', META = 'meta';
const key = (version, category, kind, value) => JSON.stringify([version, category, kind, String(value).toLowerCase()]);
const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const finished = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

export class ClientCacheMissError extends Error {
  constructor(category, path) {
    super(`尚未保存這份遊戲資料（${category}：${path}）。請先選遊戲資料夾。`);
    this.name = 'ClientCacheMissError';
    this.category = category;
    this.path = path;
  }
}

export async function gameVersion(files) {
  const candidates = [...files].filter(file => file.name.toLowerCase() === 'ffxivgame.ver');
  if (candidates.length !== 1) throw new Error('請選包含 game/ffxivgame.ver 的遊戲安裝資料夾；直接選檔時也請一起選這個版本檔案。');
  const version = (await candidates[0].text()).trim();
  if (!/^[0-9][0-9.]{2,50}$/.test(version)) throw new Error('遊戲版本檔案無法辨識，請確認選取的是同一份台服遊戲資料。');
  return version;
}

async function openDB() {
  const req = indexedDB.open(DB_NAME, 2);
  req.onupgradeneeded = () => {
    const db = req.result;
    for (const name of [FILE, FACT, META]) if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
    const files = db.createObjectStore(FILE, { keyPath: 'key' });
    files.createIndex('used', 'used');
    db.createObjectStore(FACT);
    db.createObjectStore(META);
  };
  return request(req);
}

export class ClientCache {
  static async open() {
    navigator.storage.persist?.().catch(() => false); // Chrome 可拒絕；容量上限仍由本站控制。
    const cache = new ClientCache(await openDB());
    await cache.refresh();
    return cache;
  }
  constructor(db) {
    this.db = db;
    this.pending = new Set();
    this.facts = new Map();
    this.ready = {};
    this.version = null;
    this.size = 0;
    this.usedKeys = new Set();
  }
  key(category, kind, value) { return key(this.version, category, kind, value); }
  async refresh() {
    const tx = this.db.transaction([META, FACT, FILE], 'readonly');
    const [version, ready, facts, records] = await Promise.all([
      request(tx.objectStore(META).get('version')),
      request(tx.objectStore(META).get('ready')),
      request(tx.objectStore(FACT).getAllKeys()),
      request(tx.objectStore(FILE).getAll()),
    ]);
    this.version = version ?? null;
    this.ready = ready ?? {};
    const values = await Promise.all(facts.map(k => request(tx.objectStore(FACT).get(k))));
    this.facts = new Map(facts.map((k, i) => [k, values[i]]));
    this.fileKeys = new Set(records.map(r => r.key));
    this.size = records.reduce((sum, r) => sum + r.size, 0);
    await finished(tx);
  }
  async purge() {
    await this.flush();
    const tx = this.db.transaction([META, FACT, FILE], 'readwrite');
    for (const name of [META, FACT, FILE]) tx.objectStore(name).clear();
    await finished(tx);
    this.version = null;
    this.ready = {};
    this.facts.clear();
    this.fileKeys.clear();
    this.usedKeys.clear();
    this.size = 0;
  }
  async useVersion(version) {
    if (this.version && this.version !== version) await this.purge();
    if (this.version === version) return;
    const tx = this.db.transaction(META, 'readwrite');
    tx.objectStore(META).put(version, 'version');
    await finished(tx);
    this.version = version;
  }
  track(work) {
    const p = Promise.resolve().then(work);
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }
  async flush() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
  fact(category, kind, value, result) {
    const k = this.key(category, kind, value);
    if (this.facts.get(k) === result) return;
    this.facts.set(k, result);
    this.track(async () => {
      const tx = this.db.transaction(FACT, 'readwrite');
      tx.objectStore(FACT).put(result, k);
      await finished(tx);
    }).catch(error => { this.recordingFailure = error; });
  }
  async store(category, kind, value, bytes) {
    const k = this.key(category, kind, value);
    this.usedKeys.add(k);
    const result = bytes === null ? null : new Blob([bytes]);
    const size = bytes?.byteLength ?? 0;
    const tx = this.db.transaction([FILE, FACT], 'readwrite');
    const old = await request(tx.objectStore(FILE).get(k));
    tx.objectStore(FILE).put({ key: k, data: result, size, used: Date.now() });
    tx.objectStore(FACT).put(bytes !== null, this.key(category, 'has', value));
    await finished(tx);
    this.fileKeys.add(k);
    this.facts.set(this.key(category, 'has', value), bytes !== null);
    this.size += size - (old?.size ?? 0);
    await this.trim();
  }
  async trim() {
    if (this.size <= CLIENT_CACHE_CAP) return;
    const tx = this.db.transaction(FILE, 'readwrite');
    const store = tx.objectStore(FILE);
    const candidates = await request(store.index('used').getAll());
    for (const item of candidates) {
      if (this.size <= CLIENT_CACHE_CAP) break;
      if (this.usedKeys.has(item.key)) continue;
      store.delete(item.key);
      this.fileKeys.delete(item.key);
      this.size -= item.size;
      for (const [bundle, keys] of Object.entries(this.ready)) if (keys.includes(item.key)) delete this.ready[bundle];
    }
    // 一次使用的資料若超出上限，仍正常顯示當前畫面，但不承諾能在下次造訪還原。
    if (this.size > CLIENT_CACHE_CAP) {
      for (const item of candidates) {
        if (this.size <= CLIENT_CACHE_CAP) break;
        if (!this.fileKeys.has(item.key)) continue;
        store.delete(item.key);
        this.fileKeys.delete(item.key);
        this.size -= item.size;
        for (const [bundle, keys] of Object.entries(this.ready)) if (keys.includes(item.key)) delete this.ready[bundle];
      }
    }
    await finished(tx);
    const meta = this.db.transaction(META, 'readwrite');
    meta.objectStore(META).put(this.ready, 'ready');
    await finished(meta);
  }
  recording(real) {
    const packs = {};
    for (const category of REQUIRED_PACKS) {
      const raw = real[category];
      packs[category] = {
        entries: { get: hash => {
          const entry = raw.entries.get(hash);
          this.fact(category, 'index', hash.toString(16), entry ?? null);
          return entry;
        } },
        has: path => {
          const answer = raw.has(path);
          this.fact(category, 'has', path, answer);
          return answer;
        },
        read: async path => {
          const bytes = await raw.read(path);
          try { await this.store(category, 'path', path, bytes); }
          catch (error) { this.recordingFailure = error; }
          return bytes;
        },
        readEntry: async entry => {
          const bytes = await raw.readEntry(entry);
          try { await this.store(category, 'entry', entry, bytes); }
          catch (error) { this.recordingFailure = error; }
          return bytes;
        },
      };
    }
    packs.chara = packs['040000'];
    packs.shader = packs['050000'];
    return packs;
  }
  cached() {
    const packs = {};
    for (const category of REQUIRED_PACKS) {
      const lookup = (kind, value) => {
        const k = this.key(category, kind, value);
        if (!this.facts.has(k)) throw new ClientCacheMissError(category, value);
        return this.facts.get(k);
      };
      const read = async (kind, value) => {
        const k = this.key(category, kind, value);
        this.usedKeys.add(k);
        if (!this.fileKeys.has(k)) throw new ClientCacheMissError(category, value);
        const tx = this.db.transaction(FILE, 'readonly');
        const record = await request(tx.objectStore(FILE).get(k));
        await finished(tx);
        if (!record) throw new ClientCacheMissError(category, value);
        // 記下最近使用時間；不阻擋渲染，原始資料仍由資料庫提供。
        this.track(async () => {
          const update = this.db.transaction(FILE, 'readwrite');
          update.objectStore(FILE).put({ ...record, used: Date.now() });
          await finished(update);
        });
        return record.data === null ? null : new Uint8Array(await record.data.arrayBuffer());
      };
      packs[category] = {
        entries: { get: hash => lookup('index', hash.toString(16)) ?? undefined },
        has: path => lookup('has', path),
        read: path => read('path', path),
        readEntry: entry => read('entry', entry),
      };
    }
    packs.chara = packs['040000'];
    packs.shader = packs['050000'];
    return packs;
  }
  async markBackground(bundle, keys) {
    await this.flush();
    if (this.recordingFailure || this.size > CLIENT_CACHE_CAP || keys.some(k => !this.fileKeys.has(k))) return false;
    this.ready[bundle] = [...new Set(keys)];
    const tx = this.db.transaction(META, 'readwrite');
    tx.objectStore(META).put(this.ready, 'ready');
    await finished(tx);
    return true;
  }
  hasKeys(keys) { return Array.isArray(keys) && keys.every(k => this.fileKeys.has(k)); }
  canUseBackground(bundle) {
    return this.ready[bundle]?.every(k => this.fileKeys.has(k)) ?? false;
  }
  beginBackground() { this.usedKeys = new Set(); this.recordingFailure = null; }
  backgroundKeys() { return [...this.usedKeys]; }
}
