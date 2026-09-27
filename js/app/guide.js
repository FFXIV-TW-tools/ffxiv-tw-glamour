import { REQUIRED_PACKS } from '../game/client-packs.js';
import { initNotices } from './guide-notice.js';

const DEFAULT_PATH = 'C:\\Program Files\\USERJOY GAMES\\FINAL FANTASY XIV TC';
// 這個瀏覽器曾用「選遊戲資料夾」成功讀取過；Chrome 會記住上次選的資料夾（整個瀏覽器共用）。
const PICKED_KEY = 'glamour.folderPicked';
const hasPickedFolder = () => localStorage.getItem(PICKED_KEY) === 'yes';

/** Onboarding owns its own DOM; game-app owns the file inputs' change handlers. */
export class Guide {
  constructor(root) {
    this.root = root;
    this.look = null;
    this.stage = 'folder';
    this.render();
    initNotices(root);
    window.FFXIVHelp?.setup();
    document.addEventListener('glamour:save-loaded', () => this.completeSave());
  }

  render() {
    this.root.innerHTML = `
      <span class="codex-hud" aria-hidden="true"></span>
      <div class="glamour-guide-head">
        <span class="codex-label">開始預覽</span>
        <p id="guide-next" class="codex-body" role="status">下一步：選擇電腦上的台服遊戲資料夾。</p>
        <p class="codex-body codex-tint-panel codex-tint-panel--bar codex-tint-panel--warn"><strong>必須在已安裝台服遊戲主程式的電腦上使用。</strong>本工具讀取你電腦上的遊戲檔案來顯示角色，沒有安裝遊戲就無法使用。</p>
      </div>
      <ol class="codex-steps" id="guide-steps" aria-label="開始使用的步驟">
        <li class="codex-step is-current" aria-current="step" data-guide-step="folder"><span class="codex-step__mark" aria-hidden="true"></span><span class="codex-step__body"><span class="codex-step__title">選遊戲資料夾</span><span class="codex-step__hint">在本機讀取遊戲資料</span></span></li>
        <li class="codex-step" data-guide-step="save"><span class="codex-step__mark" aria-hidden="true"></span><span class="codex-step__body"><span class="codex-step__title">載入外貌存檔</span><span class="codex-step__hint">建議</span></span></li>
        <li class="codex-step" data-guide-step="adjust"><span class="codex-step__mark" aria-hidden="true"></span><span class="codex-step__body"><span class="codex-step__title">調整角色</span><span class="codex-step__hint">外貌、裝備與背景</span></span></li>
      </ol>
      <div id="guide-detail">
        <section class="glamour-guide-part" aria-labelledby="guide-folder-title">
          <h2 class="codex-h3" id="guide-folder-title">1．選遊戲資料夾</h2>
          <p id="data-state" class="codex-body">請選擇台服遊戲資料夾。遊戲檔案只在這個瀏覽器裡讀取，不會上傳。</p>
          <p class="codex-body" id="guide-default-intro">多數玩家的遊戲安裝在預設位置：</p>
          <div class="glamour-path"><code class="codex-code" id="guide-path"></code><button type="button" class="codex-btn codex-btn--ghost codex-small" id="guide-copy">複製路徑</button></div>
          <p class="codex-body" id="pick-hint">按「選遊戲資料夾」會開啟「選取要上傳的資料夾」視窗：在視窗上方的路徑列貼上上方路徑並按 Enter，再按視窗裡的「上傳」。接著 Chrome 會問「要將 N 個檔案上傳到這個網站嗎？」，預設按鈕是取消，請按「上傳」。這兩處的「上傳」是瀏覽器固定的文字；檔案只在這個瀏覽器裡讀取，本站不會收到你的遊戲檔案。</p>
          <p class="codex-body" id="guide-returning">之前選過的話：Chrome 會記住上次選取的位置。如果視窗已停在你的遊戲資料夾，直接按視窗裡的「上傳」，Chrome 再問一次時也按「上傳」即可。這個位置是整個瀏覽器共用的；若視窗停在別處（例如期間在其他網站選過檔案或資料夾），請照上面的步驟重新找。</p>
          <p id="notice-required" class="codex-small">請先閱讀並確認使用須知，才能選遊戲資料夾。</p>
          <button type="button" class="codex-btn codex-btn--primary" id="pick" disabled data-help="請先閱讀並確認使用須知，才能選遊戲資料夾。">選遊戲資料夾</button>
          <input type="file" id="pick-dir" webkitdirectory hidden>
          <details class="codex-accordion glamour-guide-alt" id="files-alt"><summary>不在預設位置？或無法選資料夾？</summary>
            <div class="codex-accordion__body">
              <p class="codex-body">你可以手動找到包含 <code class="codex-code">game</code> 的遊戲安裝資料夾，或直接選取含 <code class="codex-code">ffxivgame.ver</code> 的 <code class="codex-code">game</code> 資料夾。</p>
              <p class="codex-body">若仍無法選資料夾，可改用「直接選檔」，一次選取同一份遊戲資料夾中的 <code class="codex-code">game/ffxivgame.ver</code>，以及以下編號開頭的全部 <code class="codex-code">.index</code> 與 <code class="codex-code">.dat</code> 檔案：<span id="guide-packs"></span>。</p>
              <label class="codex-field__label" for="files">直接選檔</label><input type="file" id="files" class="codex-input" multiple disabled>
            </div>
          </details>
        </section>
        <section class="glamour-guide-part" aria-labelledby="guide-save-title">
          <h2 class="codex-h3" id="guide-save-title">2．載入外貌存檔（建議）</h2>
          <p class="codex-body">想預覽自己的角色，請先在遊戲裡保存外貌，再到這裡匯入：</p>
          <ol class="codex-body glamour-guide-howto">
            <li>在遊戲裡到「美容師」或角色製作畫面保存外貌（遊戲稱為「角色設定資料」）。遊戲會在「文件\\My Games\\FINAL FANTASY XIV - TC」產生 <code class="codex-code">FFXIV_CHARA_01.dat</code> 這類檔案，尾端數字對應保存欄位。</li>
            <li>回到這裡，按下方「載入外貌存檔」。</li>
            <li>選擇剛才保存的那個檔案。</li>
          </ol>
          <div class="glamour-guide-actions"><button type="button" class="codex-btn codex-btn--ghost" id="guide-save" disabled data-help="請先選好遊戲資料夾，才能載入外貌存檔。">載入外貌存檔</button><button type="button" class="codex-btn codex-btn--ghost" id="guide-skip" disabled data-help="請先選好遊戲資料夾，才能略過這一步。">略過這一步</button></div>
          <p class="codex-small">若略過，會先顯示遊戲的預設角色；之後也可以在「角色外貌」載入外貌存檔。</p>
        </section>
        <section class="glamour-guide-part" aria-labelledby="guide-adjust-title">
          <h2 class="codex-h3" id="guide-adjust-title">3．調整角色</h2>
          <p class="codex-body">編輯外貌、更換裝備與染劑；在預覽畫面左右拖曳可轉動，上下拖曳可移動，滾輪可放大或縮小。也能切換室內、乙太空間、海岸、森林、荒野 5 種背景。</p>
          <button type="button" class="codex-btn codex-btn--ghost" id="guide-done" disabled data-help="請先選好遊戲資料夾，才能開始調整角色。">我知道了，開始調整</button>
        </section>
      </div>
      <div id="guide-summary" class="glamour-guide-summary" hidden><span id="guide-summary-state">已準備好預覽；可隨時更換遊戲資料夾或載入外貌存檔。</span><button type="button" class="codex-btn codex-btn--ghost" id="guide-summary-pick" hidden>選遊戲資料夾</button><button type="button" class="codex-btn codex-btn--ghost" id="guide-expand">查看步驟</button></div>`;
    this.root.querySelector('#guide-path').textContent = DEFAULT_PATH;
    this.root.querySelector('#guide-packs').textContent = REQUIRED_PACKS.join('、');
    this.root.querySelector('#guide-copy').addEventListener('click', () => window.FFXIVClipboard?.copy(DEFAULT_PATH, '遊戲安裝路徑'));
    this.root.querySelector('#guide-returning').hidden = !hasPickedFolder();
    // guide 先於 game-app 綁定，change 會先記下這次是用資料夾還是直接選檔。
    this.root.querySelector('#pick-dir').addEventListener('change', () => { this.pickedFolder = true; });
    this.root.querySelector('#files').addEventListener('change', () => { this.pickedFolder = false; });
    this.root.querySelector('#guide-save').addEventListener('click', () => this.look?.pickSave());
    this.root.querySelector('#guide-skip').addEventListener('click', () => this.advanceAdjust());
    this.root.querySelector('#guide-done').addEventListener('click', () => this.finish());
    this.root.querySelector('#guide-summary-pick').addEventListener('click', () => this.root.querySelector('#pick').click());
    this.root.querySelector('#guide-expand').addEventListener('click', () => {
      this.root.querySelector('#guide-detail').hidden = false;
      this.root.querySelector('#guide-steps').hidden = false;
      this.root.querySelector('#guide-summary').hidden = true;
    });
    const prompt = document.querySelector('#folder-prompt');
    const closePrompt = (picked) => {
      if (prompt.hidden) return;
      prompt.hidden = true;
      this.promptRelease?.();
      const cancel = this.promptCancel;
      this.promptRelease = this.promptCancel = null;
      // 仍在按鈕點擊的使用者操作內，才能開啟資料夾選擇視窗。
      if (picked) this.root.querySelector('#pick').click(); else cancel?.();
    };
    prompt.querySelector('#folder-prompt-pick').addEventListener('click', () => closePrompt(true));
    for (const id of ['folder-prompt-cancel', 'folder-prompt-close']) prompt.querySelector(`#${id}`).addEventListener('click', () => closePrompt(false));
    prompt.addEventListener('click', (event) => { if (event.target === prompt) closePrompt(false); });
    prompt.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); closePrompt(false); } });
  }

  setStage(stage) {
    this.stage = stage;
    const names = { folder: '選擇電腦上的台服遊戲資料夾。', loading: '正在讀取遊戲資料，請稍候。', save: '建議載入外貌存檔；若尚未保存，請先在遊戲裡保存。', adjust: '調整外貌、裝備與染劑，或切換背景。', done: '現在可以調整角色；如需重看說明，請展開步驟。' };
    this.root.querySelector('#guide-next').textContent = this.cached && (stage === 'adjust' || stage === 'done')
      ? '下一步：可以轉動與縮放預覽；要調整外貌或換裝，請先選遊戲資料夾。'
      : `下一步：${names[stage]}`;
    for (const step of this.root.querySelectorAll('[data-guide-step]')) {
      const rank = { folder: 1, save: 2, adjust: 3 }[step.dataset.guideStep];
      const current = { folder: 1, loading: 1, save: 2, adjust: 3, done: 4 }[stage];
      step.classList.toggle('is-done', rank < current);
      step.classList.toggle('is-current', rank === current);
      if (rank === current) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    }
    const ready = ['save', 'adjust', 'done'].includes(stage);
    for (const id of ['guide-save', 'guide-skip', 'guide-done']) {
      const button = this.root.querySelector(`#${id}`);
      button.disabled = !ready;
      if (ready) button.removeAttribute('data-help');
    }
    const pick = this.root.querySelector('#pick');
    const save = this.root.querySelector('#guide-save');
    pick.classList.toggle('codex-btn--primary', stage === 'folder' || stage === 'loading');
    pick.classList.toggle('codex-btn--ghost', stage !== 'folder' && stage !== 'loading');
    save.classList.toggle('codex-btn--primary', stage === 'save');
    save.classList.toggle('codex-btn--ghost', stage !== 'save');
  }

  packsLoading() {
    this.previousStage = this.stage;
    this.setStage('loading');
    this.root.querySelector('#data-state').textContent = '正在讀取選取的遊戲資料，請稍候。';
  }
  cachedReady(look, version) {
    this.look = look;
    this.cached = true;
    this.root.querySelector('#guide-summary-state').textContent = `已使用上次的遊戲資料（遊戲版本 ${version}）；調整外貌或換裝前請選遊戲資料夾。`;
    this.root.querySelector('#guide-summary-pick').hidden = false;
    this.compactFolder(true);
    this.root.querySelector('#data-state').textContent = `已使用上次的遊戲資料（遊戲版本 ${version}）。要調整外貌或換裝，請先選遊戲資料夾。`;
    document.querySelector('#view-empty').hidden = true;
    this.setStage('adjust');
  }
  /** 用上次保存的資料時被擋的操作：在原處開說明視窗，不把側欄捲到資料夾按鈕。 */
  cachedPrompt({ resumeText = '', onCancel = null } = {}) {
    this.root.querySelector('#data-state').textContent = '要調整外貌或換裝，請先選遊戲資料夾。';
    const prompt = document.querySelector('#folder-prompt');
    const resume = prompt.querySelector('#folder-prompt-resume');
    resume.textContent = resumeText;
    resume.hidden = !resumeText;
    this.promptCancel = onCancel;
    if (!prompt.hidden) return;
    prompt.hidden = false;
    const releaseScroll = window.FFXIVScrollLock?.lock();
    const releaseFocus = window.FFXIVA11y?.trapFocus(prompt.querySelector('.codex-modal'));
    if (!releaseFocus) prompt.querySelector('#folder-prompt-pick').focus();
    this.promptRelease = () => { releaseFocus?.(); releaseScroll?.(); };
  }
  compactFolder(compact) {
    this.root.querySelector('#guide-default-intro').hidden = compact;
    this.root.querySelector('.glamour-path').hidden = compact;
    this.root.querySelector('#pick-hint').hidden = compact;
    this.root.querySelector('#guide-returning').hidden = compact || !hasPickedFolder();
    this.root.querySelector('#pick').textContent = compact ? '更換遊戲資料夾' : '選遊戲資料夾';
  }
  packsReady(look) {
    this.look = look;
    this.cached = false;
    this.root.querySelector('#guide-summary-pick').hidden = true;
    this.root.querySelector('#guide-summary-state').textContent = '已準備好預覽；可隨時更換遊戲資料夾或載入外貌存檔。';
    if (this.pickedFolder) localStorage.setItem(PICKED_KEY, 'yes');
    this.root.querySelector('#data-state').textContent = '已讀取遊戲資料。建議載入外貌存檔，預覽自己的角色；也可以略過。';
    this.compactFolder(true);
    this.root.querySelector('#guide-detail').hidden = false;
    this.root.querySelector('#guide-steps').hidden = false;
    this.root.querySelector('#guide-summary').hidden = true;
    document.querySelector('#view-empty').hidden = true;
    this.setStage('save');
  }
  packsFailed(message) {
    this.root.querySelector('#data-state').textContent = `讀取失敗：${message}。請重新選擇遊戲資料夾。`;
    if (this.look) {
      this.root.querySelector('#guide-detail').hidden = false;
      this.root.querySelector('#guide-steps').hidden = false;
      this.root.querySelector('#guide-summary').hidden = true;
      this.setStage(this.previousStage);
      return;
    }
    document.querySelector('#view-empty').hidden = false;
    this.compactFolder(false);
    this.setStage('folder');
  }
  advanceAdjust() { if (this.look) this.setStage('adjust'); }
  completeSave() { if (this.look) this.advanceAdjust(); }
  finish() {
    if (!this.look) return;
    this.setStage('done');
    this.root.querySelector('#guide-detail').hidden = true;
    this.root.querySelector('#guide-steps').hidden = true;
    this.root.querySelector('#guide-summary').hidden = false;
  }
}
