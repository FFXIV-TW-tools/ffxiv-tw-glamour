// 外貌編輯器：只讀玩家選取的遊戲資料；存檔留在瀏覽器本機，不傳送。
import { parseCharaDat, decodeCustomize, raceCode } from '../game/customize.js';
import { charamake, choicePath, colourPalette, invalidOptions } from './look-editor-data.js';
import { LookEditor } from './look-editor.js';

const $ = (root, selector) => root.querySelector(selector);
/** 缺少玩家本機遊戲資料不是暫時性錯誤；將引擎路徑轉成可行的使用者提示。 */
function appearanceFailure(error) {
  const message = error?.message ?? '';
  const missingPart = /^([^：]+)：client 裡沒有 /.exec(message)?.[1];
  if (missingPart) return `${missingPart}不在你選取的遊戲資料裡，角色維持原樣。請改選可用的${missingPart}。`;
  if (/找不到任何臉型模型/.test(message)) return '你選取的遊戲資料裡找不到這個種族可用的臉型，角色維持原樣。';
  return '這項外貌目前無法預覽，角色維持原樣。請改選其他外貌。';
}

export class LookPanel {
  /** deps＝{ view, races, redraw, status, refit, refreshSlots } */
  constructor(root, deps) {
    Object.assign(this, deps);
    this.root = root;
    this.look = null;
    this.loaded = null;
    this.busy = false;
    root.innerHTML = `<span class="codex-hud" aria-hidden="true"></span>
    <h2 class="codex-h2">角色外貌</h2>
    <div class="glamour-look-header">
      <div><strong id="look-name">預設角色</strong><p id="look-state" class="codex-small"></p></div>
      <span id="look-edited" class="codex-badge codex-badge--warn" hidden>已調整</span>
    </div>
    <div class="glamour-look-actions">
      <button id="look-pick" type="button" class="codex-btn codex-btn--ghost">載入外貌存檔</button>
      <button id="look-reset" type="button" class="codex-btn codex-btn--ghost">恢復預設角色</button>
      <input id="look-file" type="file" accept=".dat" hidden>
    </div>
    <div id="look-error" class="codex-tint-panel codex-tint-panel--warn" role="status" hidden></div>
    <details class="codex-accordion glamour-look-adjust" id="look-adjust">
      <summary>調整外貌</summary>
      <div class="codex-accordion__body"><div id="look-editor" class="glamour-look-editor"></div></div>
    </details>`;
    $(root, '#look-adjust').addEventListener('toggle', (event) => {
      if (event.target.open && this.canEdit && !this.canEdit()) {
        event.target.open = false;
        this.needFolder();
      }
    });
    this.editor = new LookEditor($(root, '#look-editor'), this.races, {
      change: (field, value) => this.change(field, value),
      changeModel: (model) => this.changeModel(model),
      available: (c, field, id) => {
        const path = choicePath(c, field, id);
        if (this.canEdit && !this.canEdit()) return false;
        return !path || this.view.equipLayer.packs.chara.has(path);
      },
    });
    $(root, '#look-pick').addEventListener('click', () => this.pickSave());
    $(root, '#look-file').addEventListener('change', (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      if (file) this.load(file);
    });
    $(root, '#look-reset').addEventListener('click', () => this.reset());
    this.updateSummary();
  }

  updateSummary() {
    const c = this.look;
    $(this.root, '#look-name').textContent = this.loaded?.fileName ?? '預設角色';
    const name = (rows, id) => rows.find(([key]) => key === id)?.[c?.gender ? 2 : 1] ?? `#${id}`;
    $(this.root, '#look-state').textContent = c
      ? `${name(this.races.races, c.race)}・${name(this.races.tribes, c.clan)}・${c.gender ? '女性' : '男性'}`
      : '選擇遊戲資料夾後，即可調整角色外貌。';
    $(this.root, '#look-edited').hidden = !this.loaded || JSON.stringify(c) === JSON.stringify(this.loaded.c);
  }

  showWarnings(notes) {
    const box = $(this.root, '#look-error');
    box.hidden = !notes.length;
    box.textContent = notes.join('\n');
  }

  warningNotes(c, data, warnings) {
    const notes = invalidOptions(c, data);
    if (warnings.some((message) => message.includes('臉部特徵'))) notes.push('部分臉部特徵目前尚未顯示，其他外貌仍可預覽。');
    if (warnings.some((message) => !message.includes('臉部特徵'))) notes.push('部分外貌細節目前尚未顯示，實際效果請以遊戲畫面為準。');
    return notes;
  }

  displayWarnings(c, data, warnings) {
    this.showWarnings(this.warningNotes(c, data, warnings));
  }

  async enable() {
    this.defaultC = await this.view.defaultLook();
    await this.apply(this.defaultC, null);
  }

  /** 新背景準備期間不動既有畫面；commit 前先完成所有可能失敗的檔案讀取。 */
  async prepareRendered(view, warnings) {
    if (!view.equipLayer || !this.look) return null;
    const [data, cmp] = await Promise.all([charamake(this.look), colourPalette(view)]);
    return { data, cmp, notes: this.warningNotes(this.look, data, warnings) };
  }

  /** 背景成功交接後同步更新 UI，不再重建角色或讀取檔案。 */
  commitRendered(view, prepared) {
    this.view = view;
    if (!prepared) return;
    this.editor.render(this.look, prepared.data, prepared.cmp);
    this.showWarnings(prepared.notes);
  }

  async rebind(view) {
    if (!view.equipLayer || !this.look) { this.view = view; return []; }
    const { warnings } = await view.appearance(this.look);
    const prepared = await this.prepareRendered(view, warnings);
    this.commitRendered(view, prepared);
    return warnings;
  }

  async pickSave() {
    if (this.busy || !this.view.equipLayer) return;
    if (this.canEdit && !this.canEdit()) { this.needFolder(); return; }
    if (!window.showOpenFilePicker) { $(this.root, '#look-file').click(); return; }
    try {
      const [handle] = await window.showOpenFilePicker({
        id: 'ffxiv-chara', startIn: 'documents',
        types: [{ description: '外貌存檔', accept: { 'application/octet-stream': ['.dat'] } }],
      });
      if (handle) await this.load(await handle.getFile());
    } catch (error) {
      if (error.name !== 'AbortError') { console.error(error); this.status('無法開啟外貌存檔，請再試一次。'); }
    }
  }

  async load(file) {
    if (this.canEdit && !this.canEdit()) { this.needFolder(); return false; }
    let c;
    try { c = decodeCustomize(parseCharaDat(new Uint8Array(await file.arrayBuffer()))); }
    catch (error) {
      console.error(error);
      this.showWarnings([`無法讀取「${file.name}」；請確認這是遊戲保存的角色外貌存檔。`]);
      return false;
    }
    const success = await this.apply(c, file.name);
    if (success) {
      this.loaded = { c: { ...c }, fileName: file.name };
      this.updateSummary();
      document.dispatchEvent(new CustomEvent('glamour:save-loaded'));
    }
    return success;
  }

  async reset() {
    if (this.busy) return;
    if (this.canEdit && !this.canEdit()) { this.needFolder(); return; }
    await this.apply(this.defaultC ?? await this.view.defaultLook(), null);
  }

  async changeModel({ race, clan, gender }) {
    if (this.busy) return;
    if (this.canEdit && !this.canEdit()) { this.needFolder(); return; }
    if (!this.races.races.some(([id]) => id === race) ||
        !this.races.tribes.some(([id]) => id === clan) ||
        Math.ceil(clan / 2) !== race || ![0, 1].includes(gender)) return;
    this.editor.disabled(true);
    try {
      const c = { ...await this.view.defaultLook(raceCode(race, clan, gender)), race, clan, gender };
      await this.apply(c, this.loaded?.fileName ?? null);
    } catch (error) {
      console.error(error);
      this.showWarnings([appearanceFailure(error)]);
      this.editor.disabled(false);
    }
  }

  async change(field, value) {
    if (this.busy || !this.look || Object.is(this.look[field], value)) return;
    if (this.canEdit && !this.canEdit()) { this.needFolder(); return; }
    await this.apply({ ...this.look, [field]: value }, this.loaded?.fileName ?? null);
  }

  /** 僅在角色成功重建後才提交 UI 狀態；失敗保留先前的外貌。 */
  async apply(c, fileName) {
    if (this.busy || !c) return false;
    this.busy = true;
    this.editor.disabled(true);
    this.status(fileName ? `載入外貌 ${fileName}…` : '顯示角色外貌…');
    try {
      const data = await charamake(c);
      const { report, warnings } = await this.view.appearance(c);
      const cmp = await colourPalette(this.view);
      this.look = c;
      if (fileName && (!this.loaded || this.loaded.fileName !== fileName)) this.loaded = { c: { ...c }, fileName };
      if (!fileName) this.loaded = null;
      this.editor.render(c, data, cmp);
      this.updateSummary();
      this.displayWarnings(c, data, warnings);
      this.refreshSlots?.();
      this.refit?.();
      console.info(report.join('\n'));
      await this.redraw();
      this.onChange?.();
      return true;
    } catch (error) {
      console.error(error);
      const reason = appearanceFailure(error);
      this.showWarnings([reason]);
      this.status(reason);
      return false;
    } finally {
      this.busy = false;
      this.editor.disabled(false);
    }
  }
}
