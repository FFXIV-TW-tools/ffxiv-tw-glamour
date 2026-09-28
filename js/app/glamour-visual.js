import { ICONS } from './glamour-icons.js';

/** Paths come only from the portal canonical icon generator. */
export function iconSVG(name, className = 'codex-ico') {
  const path = ICONS[name];
  if (!path) throw new Error(`找不到站內圖示：${name}`);
  return `<svg class="${className}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">${path}</svg>`;
}
