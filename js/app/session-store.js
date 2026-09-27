// 最後一次畫面設定只存本機瀏覽器；不保存玩家外貌存檔本體。
const KEY = 'glamour.session';
let timer;

export function readSession() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY));
    return value?.version && value?.bundle && value?.look && value?.view ? value : null;
  } catch { return null; }
}

export function saveSession(snapshot) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(snapshot())); }
    catch (error) { console.warn('無法保存上次預覽狀態', error); }
  }, 350);
}

export function clearSession() {
  clearTimeout(timer);
  localStorage.removeItem(KEY);
}
