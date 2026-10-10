// 染劑選擇面板：同遊戲染色視窗，依色系分頁（Stain 表的色系欄）、色系內依遊戲順序排成色票格。
// stains.json 列：[id, 名稱, 0xRRGGBB, 色系, 色系內順序]
const SHADES = [[2, '白'], [4, '紅'], [5, '棕'], [6, '黃'], [7, '綠'], [8, '藍'], [9, '紫'], [10, '特殊']];

export const stainHex = (rgb) => `#${(rgb >>> 0).toString(16).padStart(6, '0')}`;

export class DyePalette {
  constructor(stains) {
    this.byId = new Map(stains.map(s => [s[0], s]));
    this.groups = SHADES.map(([shade, label]) => ({ shade, label, items: stains.filter(s => s[3] === shade).sort((a, b) => a[4] - b[4]) }))
      .filter(g => g.items.length);
    this.el = null;
  }

  name(id) { return id ? this.byId.get(id)?.[1] ?? `#${id}` : '不染'; }
  color(id) { return id ? stainHex(this.byId.get(id)?.[2] ?? 0) : null; }

  /** 在 anchor 下方開面板；onPick(id)，id＝0 不染 */
  open(anchor, current, onPick, title, trigger = anchor) {
    this.close();
    const el = document.createElement('div');
    el.className = 'glamour-dye-pop';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', title);
    const shade = this.byId.get(current)?.[3] ?? this.groups[0].shade;
    el.innerHTML = `<div class="glamour-dye-pop-head"><span>${title}</span><button type="button" class="codex-btn codex-btn--ghost glamour-dye-none" data-track="clear-dye">不染</button></div>
      <div class="codex-tabs codex-tabs--boxed glamour-dye-tabs" role="group" aria-label="染劑色系">${this.groups.map(g => `<button type="button" class="codex-tab codex-tab--boxed" data-shade="${g.shade}" aria-pressed="${g.shade === shade}">${g.label}</button>`).join('')}</div>
      <div class="glamour-dye-grid" role="group" aria-label="染劑顏色"></div><div class="glamour-dye-name codex-small" aria-live="polite">${this.name(current)}</div>`;
    const grid = el.querySelector('.glamour-dye-grid'), label = el.querySelector('.glamour-dye-name');
    const show = (s) => {
      for (const t of el.querySelectorAll('.glamour-dye-tabs button')) t.setAttribute('aria-pressed', String(+t.dataset.shade === s));
      grid.replaceChildren(...this.groups.find(g => g.shade === s).items.map(([id, name, rgb]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'glamour-dye-swatch';
        b.dataset.track = 'pick-dye';
        b.dataset.trackLabel = '選取染劑';
        b.style.background = stainHex(rgb);
        b.title = name;
        b.setAttribute('aria-label', name);
        b.setAttribute('aria-pressed', String(id === current));
        b.addEventListener('mouseenter', () => { label.textContent = name; });
        b.addEventListener('focus', () => { label.textContent = name; });
        b.addEventListener('click', () => { this.close(); onPick(id); });
        return b;
      }));
    };
    el.querySelector('.glamour-dye-tabs').addEventListener('click', (e) => { const s = e.target.closest('button')?.dataset.shade; if (s) show(+s); });
    el.querySelector('.glamour-dye-none').addEventListener('click', () => { this.close(); onPick(0); });
    show(shade);
    anchor.after(el);
    this.el = el;
    this.anchor = anchor;
    this.trigger = trigger;
    // 點面板外面或按 Esc 關閉
    this.outside = (e) => { if (!el.contains(e.target) && e.target !== anchor) this.close(); };
    this.esc = (e) => { if (e.key === 'Escape') this.close(); };
    setTimeout(() => { document.addEventListener('pointerdown', this.outside); document.addEventListener('keydown', this.esc); });
    el.querySelector('[aria-pressed="true"].glamour-dye-swatch, .glamour-dye-swatch')?.focus();
  }

  close() {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    document.removeEventListener('pointerdown', this.outside);
    document.removeEventListener('keydown', this.esc);
    if (this.trigger?.isConnected) this.trigger.focus();
    this.anchor = this.trigger = null;
  }
}
