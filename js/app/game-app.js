// 角色幻化預覽：首次讀取玩家的本機遊戲檔案；再次造訪只還原已保存的資料。
import { GameView, BUNDLES } from '../engine/game-view.js';
import { SlotPanel } from './game-slots.js';
import { LookPanel } from './game-look.js';
import { DownloadPanel } from './game-download.js';
import { Guide } from './guide.js';
import { openClientPacks } from '../game/client-packs.js';
import { ClientCache, ClientCacheMissError, gameVersion } from '../game/client-cache.js';
import { readSession, saveSession as scheduleSession, clearSession } from './session-store.js';
import { slotItems } from './slot-data.js';
import { noticesAcknowledged } from './guide-notice.js';

const $ = (selector) => document.querySelector(selector);
const status = (text) => { $('#status').textContent = text; };
const BUNDLE_LABEL = { indoor: '室內', aether: '乙太空間', coast: '海岸', forest: '森林', wilderness: '荒野' };
const guide = new Guide($('#guide'));
const dl = new DownloadPanel($('#download'), BUNDLE_LABEL);
const state = { degrees: 0, zoom: 1, center: [0.5, 0.5], bundle: 'indoor' };
let view, panel, look, packs, busy = false, pending = false, pendingInteractive = false, switching = false, settleTimer;
let clientCache, cachedMode = false, restoring = false;
window.gameView = () => view; // 開發驗證時讀回實際 WebGL 畫面；公開頁面不讀本機路徑。

function saveSession() {
  if (restoring || switching || !view || !clientCache?.version || !look?.look) return;
  scheduleSession(() => ({
    version: clientCache.version,
    bundle: state.bundle,
    look: { customize: look.look, fileName: look.loaded?.fileName ?? null },
    gear: Object.fromEntries(Object.entries(panel.worn).map(([slot, item]) => [slot, item.id])),
    stains: structuredClone(view.stains),
    view: { degrees: state.degrees, zoom: state.zoom, center: [...state.center] },
    required: clientCache.backgroundKeys(),
  }));
}

function needFolder() {
  guide.cachedPrompt();
  status('要調整外貌或換裝，請先選遊戲資料夾。');
}

function showControls() {
  for (const button of document.querySelectorAll('#bundles button')) {
    button.setAttribute('aria-pressed', String(button.dataset.bundle === state.bundle));
    button.disabled = !view || switching;
  }
  for (const id of ['angle', 'zoom', 'left', 'right', 'zero']) $("#" + id).disabled = !view || switching;
}

/** 互動停止 200 ms 後才以新投影重播完整畫面。 */
function scheduleSettle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { settleTimer = null; redraw(); }, 200);
}

/** 重畫忙時只保留最後狀態；轉動只跑一輪，停下後原本的完整兩輪補回。 */
async function redraw({ interactive = false } = {}) {
  if (!view || switching) return false;
  if (interactive) scheduleSettle();
  else if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  if (busy) {
    if (!pending) pendingInteractive = interactive;
    else pendingInteractive &&= interactive; // 已排入完整重畫時，後續快轉事件不能降級
    pending = true;
    return false;
  }
  busy = true;
  let ok = true, quick = interactive;
  try {
    do {
      pending = false;
      ({ zoom: state.zoom, center: state.center } = view.setView(state));
      const ms = await view.render({ degrees: state.degrees, interactive: quick });
      view.present(state);
      saveSession();
      status(`角度 ${state.degrees}°｜放大 ${state.zoom}×｜${quick ? '互動預覽' : '整幀'} ${Math.round(ms)} ms`);
      await new Promise(requestAnimationFrame);
      quick = pendingInteractive;
    } while (pending);
  } catch (error) {
    ok = false;
    status(`畫面無法更新：${error.message}`);
    console.error(error);
  } finally { busy = false; }
  return ok;
}

/** 純平移／縮放不重跑畫面，只把上一張結果重新取樣，停手後才修復完整投影。 */
function presentOnly() {
  if (!view || switching) return;
  scheduleSettle();
  if (busy) return; // 轉動中改變縮放時，該輪完成會用最新狀態呈現
  view.present(state);
  saveSession();
  status(`角度 ${state.degrees}°｜放大 ${state.zoom}×｜互動預覽`);
}

function setAngle(degrees) {
  state.degrees = ((Math.round(degrees) + 540) % 360) - 180;
  $('#angle').value = state.degrees;
  $('#angle-v').textContent = `${state.degrees}°`;
}

/** center 是畫面 UV；先用目前角色範圍夾住，再同步放大控制。 */
function setViewState(value, center) {
  const zoom = Math.max(1, Math.min(4, Math.round(value * 4) / 4));
  ({ zoom: state.zoom, center: state.center } = view.clampView({ zoom, center }));
  $('#zoom').value = state.zoom;
  $('#zoom-v').textContent = `${state.zoom}×`;
}

/** 調整放大倍率時，讓指標下原畫面上的點留在指標下；靠角色邊界時受範圍限制。 */
function zoomAt(value, point) {
  const zoom = Math.max(1, Math.min(4, Math.round(value * 4) / 4));
  const center = point.map((p, i) => state.center[i] + (p - 0.5) / state.zoom - (p - 0.5) / zoom);
  setViewState(zoom, center);
}

/** 初次預覽或改換種族時，讓角色範圍適合目前畫布；背景切換不重設使用者的放大與平移。 */
function fitZoom() {
  if (!view) return;
  const [u0, v0, u1, v1] = view.screen;
  setViewState(Math.min(4, Math.max(1, Math.floor(0.95 / Math.max(0.01, v1 - v0, u1 - u0) * 4) / 4)), null);
}

/** 不同背景的相機取景不同，依角色範圍中的相對位置接續使用者目前看的部位。 */
function centerOnNextBackground(previous, next) {
  if (!previous || state.zoom <= 1) return null;
  const a = previous.screen, b = next.screen;
  return [0, 1].map(i => {
    const span = a[i + 2] - a[i];
    const fraction = span ? (state.center[i] - a[i]) / span : 0.5;
    return b[i] + fraction * (b[i + 2] - b[i]);
  });
}

const SOFTWARE_RENDERER = /WARP|SwiftShader|Basic Render|llvmpipe|Software/i;
function showRenderer(name) {
  const box = $('#gpu');
  box.className = SOFTWARE_RENDERER.test(name) ? 'glamour-gpu-warn' : '';
  box.textContent = SOFTWARE_RENDERER.test(name)
    ? `繪圖裝置：${name}\n目前沒有用到顯示卡，是用 CPU 模擬繪圖，所以很卡。請到瀏覽器設定開啟「可用時使用圖形加速功能」（Chrome：設定 → 系統），重新啟動瀏覽器後再開這頁。`
    : `繪圖裝置：${name}`;
}

function showReport() {
  $('#report').textContent = Object.entries(view.g.report).map(([key, value]) => `${key}：\n  ${[].concat(value).join('\n  ')}`).join('\n');
}

/** 在畫面外完整載入、驗證、建角色並渲染；任何一步失敗，舊背景與操作狀態都不變。 */
async function loadBackground(key, selectedPacks, changeFolder = false, snapshot = null) {
  if (switching || (!changeFolder && (view ? key === state.bundle : !snapshot))) return false;
  switching = true;
  clearTimeout(settleTimer);
  settleTimer = null; // 換背景本身會完整重畫；舊畫布上的快轉修復不可延後覆蓋新畫布
  showControls();
  while (busy) await new Promise(requestAnimationFrame);
  const previous = view;
  const previousDownload = dl.items[key];
  const originalCanvas = $('#view');
  const canvas = originalCanvas.cloneNode(false);
  const stains = previous ? structuredClone(previous.stains) : {};
  let next, preparedLook, complete = false, stored = true;
  clientCache.beginBackground();
  try {
    status(`準備背景「${BUNDLE_LABEL[key]}」：網站資料與遊戲資料同步載入…`);
    next = await GameView.load(canvas, { bundle: key, packs: selectedPacks, ...dl.begin(key) });
    dl.downloaded(key);
    await next.enableEquip(selectedPacks);
    if (previous) {
      const { warnings } = await next.appearance(look.look);
      if (warnings.length) console.warn(warnings.join('\n'));
      for (const [slot, item] of Object.entries(panel.worn)) await next.equip(slot, panel.equipItem(item));
      for (const [slot, values] of Object.entries(stains)) if (next.stains[slot]) next.stains[slot] = [...values];
      preparedLook = await look.prepareRendered(next, warnings);
    } else {
      // 首次建立的 UI 回呼需要目前 view；尚未換上畫布時 redraw 由 switching 守住。
      view = next;
      const [stainRows, races] = await Promise.all([
        fetch('./data/stains.json').then(response => { if (!response.ok) throw new Error(`染劑清單 HTTP ${response.status}`); return response.json(); }),
        fetch('./data/races.json').then(response => { if (!response.ok) throw new Error(`種族清單 HTTP ${response.status}`); return response.json(); }),
      ]);
      panel = new SlotPanel($('#slots'), { view: next, stains: stainRows, redraw, status, canEdit: () => !cachedMode || restoring, needFolder, onChange: saveSession });
      look = new LookPanel($('#look'), { view: next, races, redraw, status, refit: fitZoom,
        refreshSlots: () => { for (const slot of Object.keys(panel.rows)) panel.refresh(slot); },
        canEdit: () => !cachedMode, needFolder, onChange: saveSession });
      await look.enable();
      if (!look.look) throw new Error('預設角色沒有重建成功');
      await panel.enable();
      if (snapshot) {
        if (!await look.apply(snapshot.look.customize, snapshot.look.fileName)) throw new Error('無法還原上次的角色外貌。');
        for (const [slot, id] of Object.entries(snapshot.gear ?? {})) {
          const item = (await slotItems(slot)).find(candidate => candidate.id === id);
          if (!item) throw new Error(`上次使用的裝備 ${id} 已不在清單中。`);
          await panel.wear(slot, item);
          if (panel.worn[slot]?.id !== id) throw new Error(`無法還原上次的裝備 ${id}。`);
        }
        for (const [slot, values] of Object.entries(snapshot.stains ?? {})) if (next.stains[slot]) next.stains[slot] = [...values];
        for (const slot of Object.keys(panel.rows)) panel.refresh(slot);
        // look.apply 會依新外貌自動取景；最後再套回玩家保存的取景。
        state.zoom = snapshot.view.zoom;
        state.center = [...snapshot.view.center];
      }
    }
    const nextState = next.setView({ zoom: state.zoom, center: snapshot?.view?.center ?? centerOnNextBackground(previous, next) });
    await next.render({ degrees: state.degrees });
    next.present();
    originalCanvas.replaceWith(canvas);
    bindDrag(canvas);
    if (previous) {
      view = next;
      panel.view = next;
      look.commitRendered(next, preparedLook);
      for (const slot of Object.keys(panel.rows)) panel.refresh(slot);
    }
    packs = selectedPacks;
    Object.assign(state, nextState);
    state.bundle = key;
    setAngle(state.degrees);
    setViewState(state.zoom, state.center);
    showRenderer(next.renderer);
    showReport();
    if (!cachedMode && clientCache) stored = await clientCache.markBackground(key, clientCache.backgroundKeys());
    if (changeFolder) guide.packsReady(look);
    else if (cachedMode && snapshot) guide.cachedReady(look, clientCache.version);
    dl.finish(key);
    status(`背景「${BUNDLE_LABEL[key]}」已就緒，角度 ${state.degrees}°，放大 ${state.zoom}×。${stored ? '' : '此瀏覽器目前無法完整保存遊戲資料，下次使用請重新選遊戲資料夾。'}`);
    if (previous) previous.r.gl.getExtension('WEBGL_lose_context')?.loseContext();
    complete = true;
    return true;
  } catch (error) {
    if (!previous) {
      view = panel = look = undefined;
      $('#look').replaceChildren();
      $('#slots').replaceChildren();
    }
    if (next) next.r.gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (previousDownload?.phase === 'ready' && key === state.bundle) {
      dl.stopTick();
      dl.current = null;
      dl.items[key] = previousDownload;
      dl.render();
    } else dl.fail(key, error, previous ? `原背景「${BUNDLE_LABEL[state.bundle]}」仍可使用；可再次選擇重試` : '請確認遊戲資料檔案與網路連線後再試一次');
    if (cachedMode && error instanceof ClientCacheMissError) {
      needFolder();
    } else {
      status(`無法準備背景「${BUNDLE_LABEL[key]}」：${error.message}${previous ? '；原畫面仍可使用。' : ''}`);
      console.error(error);
    }
    return false;
  } finally {
    switching = false;
    showControls();
    if (complete) saveSession();
  }
}

async function selectFiles(fileList) {
  if (switching || !fileList?.length) return;
  guide.packsLoading();
  status('正在讀取你選取的遊戲資料檔案…');
  try {
    const version = await gameVersion(fileList);
    const { packs: selected } = await openClientPacks(fileList);
    clientCache ??= await ClientCache.open();
    const changed = clientCache.version && clientCache.version !== version;
    await clientCache.useVersion(version);
    if (changed) clearSession();
    const realPacks = clientCache.recording(selected);
    if (view && cachedMode) {
      view.equipLayer.packs = realPacks;
      view.r.packs = realPacks;
      packs = realPacks;
      if (!changed) {
        cachedMode = false;
        guide.packsReady(look);
        status('已讀取遊戲資料夾，可以繼續調整外貌與換裝。');
        return;
      }
    }
    cachedMode = false;
    if (!dl.index) await dl.init();
    if (!await loadBackground(state.bundle, realPacks, true)) guide.packsFailed($('#status').textContent);
  } catch (error) {
    guide.packsFailed(error.message);
    status(`讀取遊戲資料失敗：${error.message}${view ? '；原畫面仍可使用。' : ''}`);
    console.error(error);
  }
}

// Chrome 的傳統資料夾選擇可選 Program Files；File System Access API 不行（sqpack-pick.js）。
$('#pick').addEventListener('click', () => { if (!switching) $('#pick-dir').click(); });
for (const id of ['pick-dir', 'files']) $("#" + id).addEventListener('change', async (event) => {
  await selectFiles(event.target.files);
  event.target.value = ''; // 同一個資料夾再次選擇也要觸發 change。
});

$('#angle').addEventListener('input', event => { setAngle(Number(event.target.value)); redraw({ interactive: true }); });
$('#left').addEventListener('click', () => { setAngle(state.degrees - 15); redraw(); });
$('#right').addEventListener('click', () => { setAngle(state.degrees + 15); redraw(); });
$('#zero').addEventListener('click', () => { setAngle(0); setViewState(state.zoom, null); redraw(); });
$('#zoom').addEventListener('input', event => { zoomAt(Number(event.target.value), [0.5, 0.5]); presentOnly(); });

let drag;
function bindDrag(canvas) {
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '角色預覽。左右拖曳轉動，上下拖曳移動；方向鍵也能操作，滾輪或放大控制可縮放。');
  canvas.addEventListener('pointerdown', event => {
    if (!view || switching) return;
    drag = { x: event.clientX, y: event.clientY, angle: state.degrees, center: state.center };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag || !view || switching) return;
    const oldAngle = state.degrees;
    setAngle(drag.angle + (event.clientX - drag.x) * 0.5);
    setViewState(state.zoom, [drag.center[0], drag.center[1] - (event.clientY - drag.y) / (canvas.getBoundingClientRect().height * state.zoom)]);
    if (state.degrees !== oldAngle) redraw({ interactive: true });
    else presentOnly();
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('wheel', event => {
    if (!view || switching) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(state.zoom + (event.deltaY < 0 ? 0.25 : -0.25), [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height]);
    presentOnly();
  }, { passive: false });
  canvas.addEventListener('keydown', event => {
    if (!view || switching) return;
    if (event.key === 'ArrowLeft') setAngle(state.degrees - 15);
    else if (event.key === 'ArrowRight') setAngle(state.degrees + 15);
    else if (event.key === 'ArrowUp') setViewState(state.zoom, [state.center[0], state.center[1] - 0.05 / state.zoom]);
    else if (event.key === 'ArrowDown') setViewState(state.zoom, [state.center[0], state.center[1] + 0.05 / state.zoom]);
    else return;
    event.preventDefault();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') presentOnly();
    else redraw({ interactive: true });
  });
}
bindDrag($('#view'));

$('#bundles').replaceChildren(...BUNDLES.map(key => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'codex-btn codex-btn--ghost';
  button.dataset.bundle = key;
  button.textContent = BUNDLE_LABEL[key];
  button.addEventListener('click', () => {
    if (!view || !packs) return;
    if (cachedMode && !clientCache.canUseBackground(key)) { needFolder(); return; }
    loadBackground(key, packs);
  });
  return button;
}));
showControls();
status('請先選擇電腦上的台服遊戲資料夾。');

document.addEventListener('glamour:clear-cache', async () => {
  try {
    clearSession();
    clientCache ??= await ClientCache.open();
    await clientCache.purge();
    $('#notice-clear-status').textContent = '已清除保存的遊戲資料與上次預覽設定；已下載的背景網站資料保留。';
    setTimeout(() => location.reload(), 700);
  } catch (error) {
    $('#notice-clear-status').textContent = `清除失敗：${error.message}。請在瀏覽器設定中刪除此網站的資料。`;
  }
});

async function restoreLastVisit() {
  if (!noticesAcknowledged()) return;
  const snapshot = readSession();
  if (!snapshot) return;
  const started = performance.now();
  try {
    clientCache ??= await ClientCache.open();
    if (snapshot.version !== clientCache.version) {
      await clientCache.purge();
      clearSession();
      status('遊戲版本已變更，請重新選擇遊戲資料夾。');
      return;
    }
    if (!clientCache.canUseBackground(snapshot.bundle) || !clientCache.hasKeys(snapshot.required)) {
      status('上次使用的遊戲資料不完整，請重新選擇遊戲資料夾。');
      return;
    }
    cachedMode = restoring = true;
    state.bundle = snapshot.bundle;
    state.degrees = snapshot.view.degrees;
    state.zoom = snapshot.view.zoom;
    state.center = snapshot.view.center;
    if (!dl.index) await dl.init();
    if (await loadBackground(snapshot.bundle, clientCache.cached(), false, snapshot)) {
      window.glamourRestoreMs = Math.round(performance.now() - started);
      status(`已還原上次的預覽（遊戲版本 ${clientCache.version}）。`);
    } else {
      cachedMode = false;
      state.bundle = 'indoor';
      guide.packsFailed('上次保存的遊戲資料無法讀取');
    }
  } catch (error) {
    cachedMode = false;
    state.bundle = 'indoor';
    guide.packsFailed('上次保存的遊戲資料無法讀取');
    status(`上次保存的遊戲資料無法讀取，請選遊戲資料夾：${error.message}`);
  } finally { restoring = false; }
}
restoreLastVisit();
