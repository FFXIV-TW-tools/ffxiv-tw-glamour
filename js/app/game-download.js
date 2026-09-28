// 背景衍生檔透過網站下載；遊戲原始資料從玩家選的本機資料夾讀取、逐檔驗證 SHA-256。
// 兩條管線同時進行，分開顯示「網站資料」、「本機遊戲資料」以及首幀著色器準備。
// 各包網站流量取自 index.json；Cache Storage 只保存網站資料，不保存玩家的遊戲檔案。

import { BUNDLE_BASE } from './config.js';
const INDEX_URL = `${BUNDLE_BASE}index.json`;
const CACHE_PREFIX = 'glamour-';

const mb = (b) => `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`;
const sec = (ms) => `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} 秒`;

export class DownloadPanel {
  /** root＝面板容器；labels＝{ key: 顯示名稱 } */
  constructor(root, labels) {
    this.root = root;
    this.labels = labels;
    this.index = null;   // { key: { total, files, built } }
    this.items = {};     // key → 網站／本機／著色器各自的進度、耗時、錯誤
    this.current = null;
    this.timer = null;
    this.collapsed = false;
    root.addEventListener('click', (e) => {
      if (e.target.closest('.glamour-dl-toggle')) { this.collapsed = !this.collapsed; this.render(); }
    });
  }

  async init() {
    try {
      const r = await fetch(INDEX_URL, { cache: 'no-store' });
      if (r.ok) this.index = await r.json();
    } catch (e) {
      console.warn('背景大小清單讀取失敗', e);
    }
    await this.pruneCaches();
    this.render();
  }

  /** 包建置時間當快取名稱的一部分：包重建後自動換新 */
  cacheName(key) {
    const built = this.index?.[key]?.built;
    return built ? `${CACHE_PREFIX}${key}-${built.replace(/[^0-9A-Za-z]/g, '')}` : null;
  }

  /** 刪掉不是目前任何一包的舊快取（包重建後留下的） */
  async pruneCaches() {
    if (!globalThis.caches) return;
    try {
      const keep = new Set(Object.keys(this.labels).map((k) => this.cacheName(k)).filter(Boolean));
      for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX) && !keep.has(name)) await caches.delete(name);
    } catch (e) {
      console.warn('清理舊背景快取失敗', e);
    }
  }

  /** 背景按鈕上的文字：還沒下載顯示大小，下載過打勾 */
  buttonLabel(key) {
    const item = this.items[key];
    const name = this.labels[key] ?? key;
    if (item?.phase === 'ready') return `${name} ✓`;
    const total = this.index?.[key]?.total;
    return total ? `${name}・${mb(total)}` : name;
  }

  isReady(key) { return this.items[key]?.phase === 'ready'; }

  /** 開始載入某包；回傳要傳給 GameView.load 的選項 */
  begin(key) {
    const now = performance.now();
    this.current = key;
    this.items[key] = {
      phase: 'download', loaded: 0, total: this.index?.[key]?.total ?? 0, cachedBytes: 0,
      clientLoaded: 0, clientTotal: 0, clientFiles: 0, clientDone: 0,
      startedAt: now, doneFiles: 0, files: this.index?.[key]?.files ?? 0,
    };
    this.collapsed = false;
    this.tick();
    const maybeDownloaded = () => {
      const item = this.items[key];
      if (item.hostReady && item.clientReady) this.downloaded(key);
    };
    return {
      cacheName: this.cacheName(key),
      onProgress: (p) => {
        const item = this.items[key];
        Object.assign(item, { loaded: p.loaded, total: p.total || item.total, doneFiles: p.doneFiles ?? item.doneFiles, files: p.files ?? item.files, cachedBytes: p.cachedBytes ?? item.cachedBytes });
        item.hostReady = item.files > 0 && item.doneFiles >= item.files;
        maybeDownloaded();
      },
      onClientProgress: (p) => {
        const item = this.items[key];
        Object.assign(item, { clientLoaded: p.loaded, clientTotal: p.total, clientDone: p.doneFiles, clientFiles: p.files });
        item.clientReady = item.clientDone === item.clientFiles;
        maybeDownloaded();
      },
      onCompile: (c) => { this.items[key].compile = c; },
    };
  }

  /** 下載完成（GameView.load 回來或進度到 100%）→ 進入著色器準備 */
  downloaded(key) {
    const item = this.items[key];
    if (!item || item.phase !== 'download') return;
    const now = performance.now();
    item.downloadMs = now - item.startedAt;
    item.phase = 'compile';
    item.compileStartedAt = now;
    this.render();
  }

  /** 第一張畫完 */
  finish(key) {
    const item = this.items[key];
    if (!item || item.phase === 'ready' || item.phase === 'error') return;
    if (item.phase === 'download') this.downloaded(key);
    item.compileMs = performance.now() - item.compileStartedAt;
    item.phase = 'ready';
    if (this.current === key) this.current = null;
    this.stopTick();
    this.render();
  }

  /** hint：怎麼重試（切換失敗＝再按一次；第一次打開就失敗＝重新整理），空字串不顯示 */
  fail(key, error, hint = '') {
    const item = this.items[key] ?? (this.items[key] = {});
    if (item.phase === 'error') return; // 保留第一個原因（後面常是連帶的通用訊息）
    item.phase = 'error';
    item.error = error?.message ?? String(error);
    item.hint = hint;
    if (this.current === key) this.current = null;
    this.stopTick();
    this.render();
  }

  tick() {
    this.stopTick();
    this.timer = setInterval(() => this.render(), 250);
    this.render();
  }

  stopTick() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 進行中那一包的詳細進度 */
  activeLines(key) {
    const item = this.items[key];
    const now = performance.now();
    const name = this.labels[key] ?? key;
    if (item.phase === 'download') {
      const elapsed = now - item.startedAt;
      const pct = item.total ? Math.min(100, (item.loaded / item.total) * 100) : 0;
      // 預估剩餘：用目前平均速度推。包裡先下載的是幾百個小檔、位元組增加很慢，太早估會暴衝到幾百秒
      // （2026-09-27 實測 100 Mbps：前 7 秒估 193→871 秒，實際 16–24 秒）→ 下載超過 10% 才估，之前顯示「估算中」
      const eta = item.total && item.loaded >= item.total * 0.1 && item.total > item.loaded ? (elapsed * (item.total - item.loaded)) / item.loaded : null;
      const progress = item.total
        ? `<div class="codex-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(1)}" aria-label="網站資料下載進度"><div class="codex-progress__bar" style="width:${pct.toFixed(1)}%"></div></div>`
        : '<div class="codex-progress codex-progress--indeterminate" role="progressbar" aria-label="網站資料下載進度"><div class="codex-progress__bar"></div></div>';
      return `<p class="glamour-dl-title">背景「${name}」資料準備中</p>
        <p class="glamour-dl-line"><strong>網站資料</strong> ${mb(item.loaded)} / ${item.total ? mb(item.total) : '大小未知'}${item.total ? `（${pct.toFixed(0)}%）` : ''}｜檔案 ${item.doneFiles}/${item.files || '?'}</p>${progress}
        <p class="glamour-dl-line"><strong>本機遊戲資料</strong> ${mb(item.clientLoaded)} / ${item.clientTotal ? mb(item.clientTotal) : '大小未知'}｜已驗證 ${item.clientDone}/${item.clientFiles || '?'} 份（SHA-256）</p>
        <p class="glamour-dl-line">已過 ${sec(elapsed)}｜${eta != null ? `網站資料約剩 ${sec(eta)}` : '網站資料剩餘時間估算中'}${item.cachedBytes ? `｜其中 ${mb(item.cachedBytes)} 來自這台電腦的快取` : ''}</p>`;
    }
    if (item.phase === 'compile') {
      const c = item.compile;
      const pct = c?.total ? (c.done / c.total) * 100 : 0;
      const progress = c?.total
        ? `<div class="codex-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(1)}" aria-label="畫面準備進度"><div class="codex-progress__bar" style="width:${pct.toFixed(1)}%"></div></div>`
        : '<div class="codex-progress codex-progress--indeterminate" role="progressbar" aria-label="畫面準備進度"><div class="codex-progress__bar"></div></div>';
      return `<p class="glamour-dl-title">背景「${name}」資料已就緒</p>
        <p class="glamour-dl-line"><strong>網站資料</strong> ${mb(item.loaded || item.total)}｜<strong>本機遊戲資料</strong> ${mb(item.clientLoaded)}</p>
        <p class="glamour-dl-line"><strong>準備畫面</strong> 著色器 ${c?.total ? `${c.done}/${c.total}` : '準備中'}｜已過 ${sec(performance.now() - item.compileStartedAt)}</p>${progress}
        <p class="glamour-dl-hint">第一次畫這個背景要先編譯遊戲的著色器，之後轉動、換裝都很快。</p>`;
    }
    return '';
  }

  render() {
    const active = this.current && this.items[this.current];
    const done = Object.entries(this.items).filter(([, it]) => it.phase === 'ready' || it.phase === 'error');
    if (!active && !done.length) { this.root.hidden = true; return; }
    this.root.hidden = false;
    const summary = done.map(([key, it]) => it.phase === 'error'
      ? `<li class="glamour-dl-error">${this.labels[key] ?? key}：失敗（${it.error}）${it.hint ? `<br>${it.hint}` : ''}</li>`
      : `<li>${this.labels[key] ?? key}：網站 ${mb(it.loaded || it.total)}・本機 ${mb(it.clientLoaded)}・下載 ${sec(it.downloadMs)}${it.cachedBytes ? `（快取 ${mb(it.cachedBytes)}）` : ''}・著色器 ${sec(it.compileMs)}</li>`).join('');
    this.root.innerHTML = `<div class="glamour-dl-head"><span>背景資料</span><button type="button" class="codex-btn codex-btn--ghost glamour-dl-toggle" aria-expanded="${!this.collapsed}">${this.collapsed ? '展開' : '收起'}</button></div>`
      + (this.collapsed ? '' : `${active ? this.activeLines(this.current) : ''}${summary ? `<ul class="glamour-dl-done">${summary}</ul>` : ''}`);
    for (const b of document.querySelectorAll('#bundles button')) b.textContent = this.buttonLabel(b.dataset.bundle);
  }
}
