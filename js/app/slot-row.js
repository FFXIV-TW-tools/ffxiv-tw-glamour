import { iconUrl, inGameRestriction, marketboardUrl } from './slot-data.js';

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

/** 已穿戴摘要專用：圖示、名稱與兩項等級固定兩行；完整裝備資訊留在更換清單。 */
export function wornSummary(item, character, metadata) {
  const wrap = el('div', 'glamour-slot-compact');
  const src = iconUrl(item.icon);
  const icon = el(src ? 'img' : 'span', `glamour-slot-icon${src ? '' : ' glamour-slot-icon--empty'}`);
  if (src) { icon.src = src; icon.alt = ''; icon.loading = 'lazy'; }
  else icon.setAttribute('aria-hidden', 'true');
  const text = el('span', 'glamour-slot-compact-text');
  const name = el('span', 'glamour-slot-item-name', item.name);
  name.dataset.rarity = item.rarity;
  const restriction = inGameRestriction(item, character, metadata);
  const subline = el('span', 'glamour-slot-compact-stats codex-xs',
    `物品等級 ${item.ilvl}・裝備等級 ${item.equipLevel}${restriction.allowed === false ? '・不可穿戴' : ''}`);
  wrap.title = `${item.name}；${subline.textContent}；${metadata.jobs[item.job] ?? '職業限制未明'}；${restriction.label}`;
  text.append(name, subline);
  wrap.append(icon, text);
  return wrap;
}

export function emptySummary(text) {
  const wrap = el('div', 'glamour-slot-compact');
  const icon = el('span', 'glamour-slot-icon glamour-slot-icon--empty');
  icon.setAttribute('aria-hidden', 'true');
  wrap.append(icon, el('span', 'glamour-slot-compact-text', text));
  return wrap;
}

/** 完整資料僅供展開的裝備搜尋結果使用。 */
export function itemRow(item, character, metadata, onWear) {
  const wrap = el('div', 'glamour-slot-item');
  const body = el(onWear ? 'button' : 'div', 'glamour-slot-item-body');
  if (onWear) {
    body.type = 'button';
    body.addEventListener('click', onWear);
    body.setAttribute('aria-label', `預覽裝備：${item.name}`);
  }
  const icon = iconUrl(item.icon);
  if (icon) {
    const img = el('img', 'glamour-slot-icon');
    img.src = icon;
    img.loading = 'lazy';
    img.alt = '';
    body.append(img);
  } else body.append(el('span', 'glamour-slot-icon glamour-slot-icon--empty'));
  const content = el('span', 'glamour-slot-item-content');
  const name = el('span', 'glamour-slot-item-name', item.name);
  name.dataset.rarity = item.rarity;
  content.append(name);
  const stats = el('span', 'glamour-slot-item-stats codex-small');
  stats.textContent = `物品等級 ${item.ilvl}・裝備等級 ${item.equipLevel}・${metadata.jobs[item.job] ?? '職業限制未明'}・染色格數 ${item.dye}`;
  content.append(stats);
  const restriction = inGameRestriction(item, character, metadata);
  if (!restriction.allowed) {
    const warning = el('span', 'codex-badge codex-badge--warn glamour-slot-restriction',
      restriction.allowed === false ? '遊戲內不可穿戴' : '限制未明');
    warning.title = restriction.label;
    warning.setAttribute('aria-label', restriction.label);
    content.append(warning);
  }
  body.append(content);
  wrap.append(body);
  const link = el('a', 'glamour-slot-source codex-small', '查來源 →');
  link.href = marketboardUrl(item.id);
  link.target = 'ffxiv-marketboard';
  link.setAttribute('aria-label', `${item.name}：到市場板查來源（共用分頁）`);
  wrap.append(link);
  return wrap;
}
