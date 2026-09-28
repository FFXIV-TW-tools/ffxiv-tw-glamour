// 裝備部位：選好遊戲資料夾即讀預設服裝小檔；按下「更換」才讀取該部位的完整物品檔。
import { SLOT_CODE } from '../engine/equip-slots.js';
import { DyePalette } from './dye-palette.js';
import { inGameRestriction, marketboardUrl, presetItems, slotCode, slotItems, slotMetadata } from './slot-data.js';
import { emptySummary, itemRow, wornSummary } from './slot-row.js';
import { iconSVG } from './glamour-visual.js';

export const SLOT_LABEL = { Head: '頭部', Top: '身體', Arms: '手部', Legs: '腿部', Feet: '腳部', Ear: '耳飾', Neck: '項鍊', Wrist: '手環', RFinger: '右手戒指', LFinger: '左手戒指' };
const SLOT_BY_CODE = Object.fromEntries(Object.entries(SLOT_CODE).map(([slot, code]) => [code, slot]));
const PAGE = 60;
export function matchingEquipment(sorted, query, wearable, character, metadata) {
  const named = query ? sorted.filter((item) => item.name.includes(query)) : sorted;
  return wearable ? named.filter((item) => inGameRestriction(item, character, metadata).allowed !== false) : named;
}

export function outfitText(slots, worn, presets, blockedBy, stains, palette) {
  return slots.map(([slot, label]) => {
    const item = worn[slot] ?? presets[slot];
    const name = blockedBy[slot] ? `${item?.name ?? '未穿戴'}（被${slots.find(([key]) => key === blockedBy[slot])?.[1] ?? '其他部位'}裝備遮住）` : item?.name ?? '未穿戴';
    const dyes = item?.dye && stains[slot]
      ? stains[slot].slice(0, Math.min(2, item.dye)).map((id, index) => `染劑 ${index + 1}：${palette.name(id)}`).join('、') : '';
    return `${label}：${name}${dyes ? `｜${dyes}` : ''}`;
  }).join('\n');
}

export class SlotPanel {
  /** deps＝{ view, stains, redraw(), status(text) } */
  constructor(root, deps) {
    Object.assign(this, deps);
    this.root = root;
    this.palette = new DyePalette(this.stains);
    this.worn = {};
    this.blockedBy = {};
    this.enabled = false;
    this.rows = {};
    root.classList.remove('codex-empty', 'codex-empty--bare');
    for (const slot of Object.keys(SLOT_CODE)) this.rows[slot] = this.buildRow(slot);
    root.replaceChildren(...Object.values(this.rows).map((row) => row.el));
    for (const slot of Object.keys(this.rows)) this.refresh(slot);
  }

  async enable() {
    this.presets = await presetItems();
    this.enabled = true;
    for (const slot of Object.keys(this.rows)) this.refresh(slot);
    const copy = document.querySelector('#glamour-copy-outfit');
    copy.disabled = false;
    copy.removeAttribute('title');
    copy.onclick = () => this.copyOutfit();
  }

  presetItem(slot) {
    const o = this.view.presetOutfit?.[slot];
    if (!o?.set) return null;
    return this.presets?.byCode[slotCode[slot]]?.find((item) => item.set === o.set && item.variant === o.variant)
      ?? { name: `預設服裝（${o.set}-${o.variant}）`, dye: 2 };
  }

  buildRow(slot) {
    const element = document.createElement('div');
    element.className = 'glamour-slot';
    element.innerHTML = `<div class="glamour-slot-main">
      <strong class="glamour-slot-label">${SLOT_LABEL[slot]}</strong>
      <div class="glamour-slot-worn"></div>
      <div class="glamour-slot-dyes" role="group" aria-label="${SLOT_LABEL[slot]}染劑"></div>
      <button type="button" class="codex-btn codex-btn--ghost glamour-slot-change" aria-expanded="false">更換</button>
    </div><p class="glamour-slot-error" role="alert" hidden></p>
    <div class="glamour-slot-picker" hidden>
      <div class="codex-toolbar" role="group" aria-label="裝備搜尋與排序">
        <label class="codex-field glamour-slot-search-field"><span class="codex-field__label">搜尋裝備名稱</span>
          <span class="codex-search">${iconSVG('magnifying-glass', 'codex-search__icon')}<input type="search" class="codex-input glamour-slot-q" placeholder="輸入裝備名稱"></span></label>
        <label class="codex-field"><span class="codex-field__label">排序</span>
          <select class="codex-select glamour-slot-sort"><option value="new">新物品優先</option><option value="ilvl">物品等級高優先</option></select></label>
        <button type="button" class="codex-chip glamour-slot-wearable" aria-pressed="false">只看可穿戴</button>
      </div>
      <div class="glamour-slot-results"></div>
      <div class="glamour-slot-picker-actions">
        <button type="button" class="codex-btn codex-btn--ghost glamour-slot-reset">恢復預設服裝</button>
        <a class="glamour-slot-current-source codex-small" target="ffxiv-marketboard" hidden>目前裝備：查來源 →</a>
      </div>
    </div>`;
    const $ = (name) => element.querySelector(`.glamour-slot-${name}`);
    const row = { el: element, item: $('worn'), dyes: $('dyes'), error: $('error'), picker: $('picker'), q: $('q'), sort: $('sort'), wearable: $('wearable'), results: $('results'), change: $('change'), source: $('current-source'), items: null };
    row.change.addEventListener('click', () => this.togglePicker(slot));
    row.q.addEventListener('input', () => this.search(slot));
    row.sort.addEventListener('change', () => this.search(slot));
    row.wearable.addEventListener('click', () => { row.wearable.setAttribute('aria-pressed', String(row.wearable.getAttribute('aria-pressed') !== 'true')); this.search(slot); });
    $('reset').addEventListener('click', () => this.wear(slot, null));
    return row;
  }

  refresh(slot) {
    const row = this.rows[slot];
    const worn = this.worn[slot];
    const preset = this.presetItem(slot);
    const current = this.view.equipLayer?.body?.c;
    const displayed = worn ?? preset;
    const metadata = worn ? row.metadata : this.presets?.metadata;
    if (!this.enabled) row.item.replaceChildren(emptySummary('選擇遊戲資料夾後，即可更換裝備。'));
    else if (this.blockedBy[slot]) row.item.replaceChildren(emptySummary(`被${SLOT_LABEL[this.blockedBy[slot]]}的裝備遮住。`));
    else if (displayed?.id && metadata) row.item.replaceChildren(wornSummary(displayed, current, metadata));
    else row.item.replaceChildren(emptySummary(displayed?.name ?? '未穿戴裝備'));
    row.source.hidden = !displayed?.id;
    if (displayed?.id) {
      row.source.href = marketboardUrl(displayed.id);
      row.source.setAttribute('aria-label', `${displayed.name}：到市場板查來源（共用分頁）`);
    }
    row.el.classList.toggle('is-changed', !!worn);
    let changed = row.el.querySelector('.glamour-slot-changed');
    if (worn && !changed) { changed = document.createElement('span'); changed.className = 'glamour-slot-changed codex-badge codex-badge--warn'; changed.textContent = '已更換'; row.item.append(changed); }
    if (!worn) changed?.remove();
    row.change.disabled = !this.enabled || !!row.loading;
    row.change.title = this.enabled ? '' : '請先選擇遊戲資料夾。';
    const stains = this.view.stains[slot];
    const count = stains && displayed?.dye ? Math.min(2, displayed.dye) : 0;
    row.dyes.replaceChildren(...Array.from({ length: count }, (_, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'glamour-slot-dye-button';
      const id = stains[index] ?? 0;
      const label = `染劑 ${index + 1}：${this.palette.name(id)}`;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.style.setProperty('--glamour-dye-color', this.palette.color(id) ?? 'var(--color-bg)');
      button.classList.toggle('is-empty', !id);
      button.addEventListener('click', () => this.palette.open(row.dyes, id, (pick) => {
        this.view.stains[slot][index] = pick;
        this.refresh(slot);
        row.dyes.children[index]?.focus();
        this.redraw();
        this.onChange?.();
      }, `${SLOT_LABEL[slot]}・染劑 ${index + 1}`, button));
      return button;
    }));
    row.dyes.hidden = !count;
    if (!row.picker.hidden && !row.loading && row.items && row.metadata) this.search(slot);
  }

  async togglePicker(slot) {
    const row = this.rows[slot];
    if (row.loading) return;
    const opening = row.picker.hidden;
    for (const [name, other] of Object.entries(this.rows)) {
      if (name !== slot) { other.picker.hidden = true; other.change.setAttribute('aria-expanded', 'false'); }
    }
    row.picker.hidden = !opening;
    row.change.setAttribute('aria-expanded', String(opening));
    if (!opening) { this.palette.close(); return; }
    row.error.hidden = true;
    row.results.textContent = '讀取這個部位的裝備中…';
    row.loading = true;
    this.refresh(slot);
    try {
      [row.items, row.metadata] = await Promise.all([slotItems(slot), slotMetadata()]);
      row.sortedNew = [...row.items].sort((a, b) => b.id - a.id);
      row.sortedIlvl = [...row.items].sort((a, b) => b.ilvl - a.ilvl || b.id - a.id);
      this.refresh(slot);
      this.search(slot);
      row.q.focus();
    } catch (error) {
      console.error(error);
      row.error.textContent = '裝備清單暫時無法載入，請關閉清單後重試。';
      row.error.hidden = false;
      row.results.textContent = '讀取失敗，關閉後重新展開即可重試。';
    } finally {
      row.loading = false;
      this.refresh(slot);
    }
  }

  search(slot, more = false) {
    const row = this.rows[slot];
    if (!row.items || !row.metadata) return;
    const q = row.q.value.trim();
    const sorted = row.sort.value === 'ilvl' ? row.sortedIlvl : row.sortedNew;
    const current = this.view.equipLayer?.body?.c;
    const wearable = row.wearable.getAttribute('aria-pressed') === 'true';
    const hits = matchingEquipment(sorted, q, wearable, current, row.metadata);
    row.shown = more ? row.shown + PAGE : PAGE;
    const count = document.createElement('p');
    count.className = 'glamour-slot-hint codex-small';
    count.textContent = `${q ? `符合「${q}」` : '全部'}${wearable ? '（只看可穿戴與限制未明）' : ''}：${hits.length} 件裝備`;
    const results = hits.slice(0, row.shown).map((item) => itemRow(item, current, row.metadata, () => this.wear(slot, item)));
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'codex-empty codex-empty--bare';
      empty.textContent = q ? `找不到符合「${q}」的裝備，請換個名稱或清除搜尋。` : '沒有符合目前篩選條件的裝備；請關閉「只看可穿戴」再試。';
      results.push(empty);
    }
    row.results.replaceChildren(count, ...results);
    if (hits.length > row.shown) {
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'codex-btn codex-btn--ghost glamour-slot-more';
      next.textContent = `再顯示 ${Math.min(PAGE, hits.length - row.shown)} 件（尚有 ${hits.length - row.shown} 件）`;
      next.addEventListener('click', () => this.search(slot, true));
      row.results.append(next);
    }
  }

  async copyOutfit() {
    if (!this.enabled) return;
    const presets = Object.fromEntries(Object.keys(this.rows).map((slot) => [slot, this.presetItem(slot)]));
    const text = outfitText(Object.entries(SLOT_LABEL), this.worn, presets, this.blockedBy, this.view.stains, this.palette);
    const status = document.querySelector('#glamour-copy-status');
    let result = false;
    try { result = await window.FFXIVClipboard.copy(text, '目前穿搭'); }
    catch (error) { console.error('複製目前穿搭失敗', error); }
    status.hidden = false;
    status.textContent = result ? '已複製目前穿搭。' : '複製失敗，請檢查瀏覽器剪貼簿權限後再試。';
  }

  equipItem(item) {
    return item && { set: item.set, variant: item.variant, blocks: item.blocks.map((code) => SLOT_BY_CODE[code]).filter(Boolean) };
  }

  async reapply() {
    const failed = [];
    for (const [slot, item] of Object.entries(this.worn)) {
      try { await this.view.equip(slot, this.equipItem(item)); }
      catch (error) {
        console.error(error);
        failed.push(`${SLOT_LABEL[slot]}目前無法預覽這件裝備。`);
        delete this.worn[slot];
      }
    }
    for (const slot of Object.keys(this.rows)) this.refresh(slot);
    return failed;
  }

  async wear(slot, item) {
    const row = this.rows[slot];
    if (this.canEdit && !this.canEdit()) {
      this.needFolder(() => this.wear(slot, item), item ? `選好後會直接換上「${item.name}」。` : `選好後會直接把${SLOT_LABEL[slot]}恢復成預設服裝。`);
      return;
    }
    row.error.hidden = true;
    this.status(item ? `預覽「${item.name}」…` : `${SLOT_LABEL[slot]}恢復預設服裝…`);
    try {
      const report = await this.view.equip(slot, this.equipItem(item));
      if (item) this.worn[slot] = item; else delete this.worn[slot];
      for (const [name, by] of Object.entries(this.blockedBy)) if (by === slot) { delete this.blockedBy[name]; this.refresh(name); }
      for (const code of item?.blocks ?? []) {
        const name = SLOT_BY_CODE[code];
        if (name && name !== slot) { this.blockedBy[name] = slot; this.refresh(name); }
      }
      row.picker.hidden = true;
      row.change.setAttribute('aria-expanded', 'false');
      this.lastReport = report;
      this.refresh(slot);
      await this.redraw();
      this.onChange?.();
    } catch (error) {
      console.error(error);
      row.error.textContent = '這件裝備目前無法預覽，請選擇其他裝備。';
      row.error.hidden = false;
      this.status('無法預覽這件裝備，原因顯示在該部位下方。');
    }
  }
}
