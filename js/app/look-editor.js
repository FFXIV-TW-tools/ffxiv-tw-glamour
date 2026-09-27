import { colourIds, rgbaCss, swatchColour } from './look-editor-data.js';

const iconUrl = (icon) => {
  if (!icon) return null;
  const folder = String(Math.floor(icon / 1000) * 1000).padStart(6, '0');
  return `https://v2.xivapi.com/api/asset/ui/icon/${folder}/${String(icon).padStart(6, '0')}_hr1.tex?format=png`;
};

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

export class LookEditor {
  constructor(root, races, { change, changeModel, available }) {
    this.root = root;
    this.races = races;
    this.change = change;
    this.changeModel = changeModel;
    this.available = available;
    this.openGroups = new Set(); // 只保留玩家自己展開的分組；載入、換背景或改種族都不自動展開
  }

  section(title) {
    const details = el('details', 'codex-accordion glamour-look-group');
    details.open = this.openGroups.has(title);
    details.append(el('summary', '', title));
    const body = el('div', 'codex-accordion__body');
    details.append(body);
    this.root.append(details);
    return body;
  }

  select(parent, label, value, options, onChange) {
    const field = el('label', 'codex-field glamour-look-field');
    field.append(el('span', 'codex-field__label', label));
    const select = el('select', 'codex-select');
    for (const [id, name] of options) {
      const option = el('option', '', name);
      option.value = id;
      select.append(option);
    }
    select.value = String(value);
    select.addEventListener('change', () => onChange(+select.value));
    field.append(select);
    parent.append(field);
  }

  grid(parent, label, field, options, current, className = '', disabledReason = '') {
    const wrap = el('div', 'glamour-look-field');
    wrap.append(el('div', 'codex-field__label', label));
    const grid = el('div', `glamour-look-choice-grid ${className}`.trim());
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', label);
    let missing = 0;
    for (const option of options) {
      if (!disabledReason && !this.available(this.current, field, option.id)) { missing++; continue; }
      const button = el('button', 'glamour-look-choice');
      button.type = 'button';
      button.disabled = !!disabledReason;
      if (disabledReason) button.dataset.unsupported = 'true';
      let description = '';
      if (option.unlockable) {
        description = option.unlockName ? `；需使用「${option.unlockName}」解鎖` : '；需先在遊戲內解鎖';
      }
      button.setAttribute('aria-label', `${label} ${option.id || '無'}${description}${disabledReason ? `；${disabledReason}` : ''}`);
      button.title = button.getAttribute('aria-label');
      button.setAttribute('aria-pressed', String(current === option.id));
      const icon = el('span', 'glamour-look-choice-icon');
      icon.setAttribute('aria-hidden', 'true');
      if (option.icon) {
        const fallback = el('span', 'glamour-look-choice-fallback', '載入中');
        const img = el('img', 'glamour-look-choice-image');
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('load', () => { fallback.hidden = true; });
        img.addEventListener('error', () => { fallback.textContent = '無圖'; });
        img.src = iconUrl(option.icon);
        icon.append(fallback, img);
      } else icon.textContent = '無';
      button.append(icon);
      button.append(el('span', 'glamour-look-choice-number codex-xs', String(option.id || '無')));
      if (option.unlockable) button.append(el('span', 'glamour-look-unlock codex-xs', '解鎖'));
      if (!button.disabled) button.addEventListener('click', () => this.change(field, option.id));
      grid.append(button);
    }
    wrap.append(grid);
    parent.append(wrap);
    if (disabledReason) parent.append(el('p', 'glamour-look-note codex-small', disabledReason));
    if (missing) parent.append(el('p', 'glamour-look-note codex-small', `另有 ${missing} 個選項台服尚未推出，暫不列出。`));
  }

  range(parent, label, field, def, current, disabledReason = '') {
    if (!def) return;
    const wrap = el('label', 'glamour-look-field');
    const top = el('span', 'glamour-look-range-head');
    top.append(el('span', 'codex-field__label', label));
    const output = el('output', 'codex-small', `${current}`);
    top.append(output);
    wrap.append(top);
    const input = el('input', 'glamour-look-range');
    input.type = 'range';
    input.disabled = !!disabledReason;
    if (disabledReason) input.dataset.unsupported = 'true';
    input.min = def.min;
    input.max = def.max;
    input.value = current;
    input.addEventListener('input', () => { output.value = input.value; });
    input.addEventListener('change', () => this.change(field, +input.value));
    wrap.append(input);
    parent.append(wrap);
    if (disabledReason) parent.append(el('p', 'glamour-look-note codex-small', disabledReason));
  }

  toggle(parent, label, field, value) {
    const wrap = el('label', 'codex-switch glamour-look-toggle');
    const input = el('input', 'codex-switch__input');
    input.type = 'checkbox';
    input.checked = !!value;
    input.addEventListener('change', () => this.change(field, input.checked));
    wrap.append(input, el('span', 'codex-switch__track'));
    wrap.append(el('span', '', label));
    parent.append(wrap);
  }

  colors(parent, label, field, config, c, cmp) {
    if (!config) return;
    const wrap = el('div', 'glamour-look-field');
    wrap.append(el('div', 'codex-field__label', label));
    const grid = el('div', 'glamour-look-swatches');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', label);
    for (const id of colourIds(field, config.count)) {
      const button = el('button', 'glamour-look-swatch');
      button.type = 'button';
      button.style.setProperty('--glamour-swatch', rgbaCss(swatchColour(cmp, config.palette, c, id)));
      button.title = `${label} ${id}`;
      button.setAttribute('aria-label', `${label} ${id}`);
      button.setAttribute('aria-pressed', String(c[field] === id));
      button.addEventListener('click', () => this.change(field, id));
      grid.append(button);
    }
    wrap.append(grid);
    parent.append(wrap);
  }

  render(c, data, cmp) {
    this.current = c;
    this.openGroups = new Set([...this.root.querySelectorAll('.glamour-look-group[open]')]
      .map((group) => group.querySelector('summary').textContent));
    this.root.replaceChildren();
    const identity = this.section('種族與體型');
    this.select(identity, '種族', c.race, this.races.races.map(([id, male, female]) => [id, c.gender ? female : male]),
      (race) => this.changeModel({ race, clan: race * 2 - 1, gender: c.gender }));
    this.select(identity, '部族', c.clan, this.races.tribes.filter(([id]) => Math.ceil(id / 2) === c.race)
      .map(([id, male, female]) => [id, c.gender ? female : male]), (clan) => this.changeModel({ race: c.race, clan, gender: c.gender }));
    this.select(identity, '性別', c.gender, [[0, '男性'], [1, '女性']],
      (gender) => this.changeModel({ race: c.race, clan: c.clan, gender }));
    this.range(identity, data.ranges.height?.label ?? '身高', 'height', data.ranges.height, c.height);
    this.range(identity, data.ranges.muscleOrTailLength?.label ?? '體型', 'tailLength', data.ranges.muscleOrTailLength, c.tailLength,
      `目前無法預覽${data.ranges.muscleOrTailLength?.label ?? '體型'}，因此暫不提供調整。`);
    this.range(identity, data.ranges.bust?.label ?? '胸圍', 'bust', data.ranges.bust, c.bust);
    if (data.raceFeature) this.grid(identity, data.raceFeature.label, 'tail', data.raceFeature.options, c.tail, '',
      [2, 3].includes(c.race) ? `目前無法預覽${data.raceFeature.label}，因此暫不提供調整。` : '');

    const face = this.section('臉部');
    this.grid(face, data.faces.label, 'face', data.faces.options, c.face);
    for (const field of ['brows', 'eyeShape', 'nose', 'jaw', 'mouth']) {
      const range = data.ranges[field];
      this.range(face, range?.label ?? field, field, range, c[field]);
    }
    this.toggle(face, '小瞳孔', 'smallIris', c.smallIris);
    const note = el('p', 'glamour-look-note codex-small', '臉部特徵目前無法在預覽畫面中呈現，因此暫不提供調整。');
    face.append(note);

    const hair = this.section('髮型與顏色');
    this.grid(hair, data.hair.label, 'hair', data.hair.options, c.hair, 'glamour-look-hair-grid');
    this.colors(hair, data.colors.hairColor?.label ?? '髮色', 'hairColor', data.colors.hairColor, c, cmp);
    this.toggle(hair, '挑染', 'highlights', c.highlights);
    this.colors(hair, data.colors.highlightColor?.label ?? '挑染', 'highlightColor', data.colors.highlightColor, c, cmp);

    const colors = this.section('膚色與瞳色');
    for (const field of ['skin', 'eyeRight', 'eyeLeft']) {
      const label = field === 'eyeRight' ? '右眼瞳色' : field === 'eyeLeft' ? '左眼瞳色' : data.colors[field]?.label;
      this.colors(colors, label, field, data.colors[field], c, cmp);
    }

    const makeup = this.section('唇色與面妝');
    this.toggle(makeup, '口紅', 'lipstick', c.lipstick);
    this.colors(makeup, data.colors.lipColor?.label ?? '唇色', 'lipColor', data.colors.lipColor, c, cmp);
    this.grid(makeup, data.facePaint.label, 'paint', data.facePaint.options, c.paint);
    this.toggle(makeup, '反轉面妝', 'paintReversed', c.paintReversed);
    this.colors(makeup, data.colors.paintColor?.label ?? '面妝顏色', 'paintColor', data.colors.paintColor, c, cmp);
  }

  disabled(value) {
    this.root.querySelectorAll('button, select, input').forEach((node) => { node.disabled = value || node.dataset.unsupported === 'true'; });
  }
}
