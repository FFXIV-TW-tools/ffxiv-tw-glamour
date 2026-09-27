import { BUNDLE_BASE } from './config.js';

const ACK_KEY = 'glamour.notices.2026-09';
export const noticesAcknowledged = () => localStorage.getItem(ACK_KEY) === 'yes';
const LABELS = { indoor: '室內', aether: '乙太空間', coast: '海岸', forest: '森林', wilderness: '荒野' };
let notice, releaseFocus, releaseScroll;

function formatSizes(index) {
  return Object.entries(LABELS).map(([key, label]) => {
    const bytes = index[key]?.total;
    return `${label}約 ${bytes ? Math.ceil(bytes / 1e6) : '未知'} MB`;
  }).join('、');
}

function close() {
  if (notice.hidden) return;
  notice.hidden = true;
  releaseFocus?.();
  releaseScroll?.();
  releaseFocus = releaseScroll = null;
}

function open() {
  if (!notice.hidden) return;
  notice.hidden = false;
  releaseScroll = window.FFXIVScrollLock?.lock();
  releaseFocus = window.FFXIVA11y?.trapFocus(notice.querySelector('.codex-modal'));
  if (!releaseFocus) notice.querySelector('#notice-ack').focus();
}

/** Browser-only notices are available before any player action or background download. */
export function initNotices(root) {
  notice = document.querySelector('#notice');
  const pick = root.querySelector('#pick');
  const files = root.querySelector('#files');
  const allowed = noticesAcknowledged();
  root.querySelector('#notice-required').hidden = allowed;
  pick.disabled = files.disabled = !allowed;
  if (allowed) pick.removeAttribute('data-help');
  for (const id of ['notice-open', 'notice-side-open']) document.getElementById(id).addEventListener('click', open);
  notice.querySelector('#notice-clear').addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('glamour:clear-cache'));
  });
  notice.querySelector('#notice-ack').addEventListener('click', () => {
    localStorage.setItem(ACK_KEY, 'yes');
    pick.disabled = files.disabled = false;
    pick.removeAttribute('data-help');
    root.querySelector('#notice-required').hidden = true;
    close();
    pick.focus();
  });
  notice.querySelector('#notice-close').addEventListener('click', close);
  notice.addEventListener('click', (event) => { if (event.target === notice) close(); });
  notice.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  if (!allowed && !matchMedia('(max-width: 1020px), (hover: none) and (pointer: coarse)').matches) open();

  const sizes = document.querySelector('#notice-sizes');
  fetch(`${BUNDLE_BASE}index.json`, { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }).then((index) => {
    sizes.textContent = formatSizes(index);
  }).catch(() => { sizes.textContent = '目前無法取得各背景的下載大小；請確認網路連線，再選擇遊戲資料夾。'; });
}
