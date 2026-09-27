// 外觀預覽測試版：包 FrameReplay，依轉角、染劑、換裝改輸入後重跑整幀，結果畫到頁面 canvas。
// 資料＝tools/build-replay-frame.mjs <擷取> --game --out tmp/replay/<背景> 產生的一包（美容師 5 背景：indoor／aether／coast／forest／wilderness；
// 背景繪圖一起重播、不隨角色轉動，放大時一起套投影裁切）。轉換規則見 tools/game-mode.mjs；換裝見 equip.js。
import { FrameReplay } from './frame.js';
import { present } from './frame-special.js';
import { viewRotation, rotateJoints, rotateDirectionAt, rotateConnection } from './rotate.js';
import { EquipLayer, isCharacterDraw } from './equip.js';
import { parseStm, applyDye } from '../game/dye.js';
import { BUNDLE_BASE } from '../app/config.js';


/** 4×4 相乘 a·b（列優先） */
function mul4(a, b) {
  const o = new Float64Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]; o[r * 4 + c] = s; }
  return o;
}
export const BUNDLES = ['indoor', 'aether', 'coast', 'forest', 'wilderness'];
// 只略過 SSR 的深度金字塔與反射鏈；原色彩目標仍接著做霧、TAA、曝光與後製，停手後完整重播補回。
const INTERACTIVE_SKIP = { skip: op => op.cs === 'compute-CreateHierarchicalZ' || op.ps?.startsWith('shcd-Reflection') };
export class GameView {
  /** bundle：BUNDLE_BASE 下的背景包；玩家選檔後才載入。 */
  static async load(canvas, { bundle = 'indoor', onProgress, onClientProgress, onCompile, cacheName, packs } = {}) {
    if (!BUNDLES.includes(bundle)) throw new Error(`沒有這個背景包：${bundle}（可選 ${BUNDLES.join('／')}）`);
    const view = new GameView(await FrameReplay.load(`${BUNDLE_BASE}${bundle}/`, canvas, { onProgress, onClientProgress, onCompile, cacheName, packs }));
    view.bundle = bundle;
    await view.init();
    return view;
  }

  constructor(replay) {
    this.r = replay;
    this.m = replay.m;
    this.g = replay.m.game;
    this.theta = 0;
    this.stains = {};        // 裝備欄 → [染劑 1, 染劑 2]
    this.buffers = new Map(); // 改過的常數緩衝（依繪圖×階段×槽重用）：{ buf, size, stamp, op }
    this.sourceCbs = new Map(); // 原始 cb 依檔名＋大小補零一次；換下虛擬檔時由 equip.dispose 移除
    this.cameraCache = new Map(); // 同角度的 136 筆角色繪圖只需算 6 種相機旋轉矩陣
    this.opByI = new Map(replay.m.ops.map(o => [o.i ?? o.at, o])); // 擷取時的全部操作（換裝會改 m.ops）
    this.extraColorsets = {}; // 換上的裝備的色表（equip.js）
    // 不預設顯示擷取的角色：畫面先只畫背景，選好遊戲資料夾後由 equip.js appearance() 重建預設角色或玩家的外貌
    this.fullOps = replay.m.ops;
    this.m.ops = this.fullOps.filter(o => !isCharacterDraw(this.m, o));
  }

  async init() {
    const g = this.g;
    if (!g) throw new Error('資料不是測試版（缺 manifest.game）；請用 build-replay-frame.mjs --game 產生');
    this.stm = { legacy: parseStm(await this.r.bytesOf({ file: g.stm.legacy })), gud: parseStm(await this.r.bytesOf({ file: g.stm.gud })) };
    // 染劑只給重建出來的裝備（extraColorsets）；擷取角色的色表（g.colorsets）跟著擷取角色不畫
    this.r.cbHook = (op, stage, slot, v) => this.patchCb(op, stage, slot, v);
    this.r.onReset = () => this.applyInputs(); // 每次重跑前重算接縫頂點與色表（2026-09-26 補回：這行曾遺失，期間染色與接縫轉動沒有生效）
    this.r.checkErrors = false; // 互動重畫時不逐筆查 GL 錯誤（每次查詢都要同步等 GPU 行程）
  }

  /** 可染色的裝備欄（至少一個材質的色表已驗證＝遊戲那張） */
  get dyeSlots() { return Object.keys(this.stains); }

  /** 選好遊戲資料夾後開放換裝：packs 包含 chara／shader 與背景用的 000000、010000、020000。 */
  async enableEquip(packs) {
    this.equipLayer = await new EquipLayer(this, packs).init();
    return this.equipLayer;
  }

  /** 換裝（item＝null 恢復預設服裝）；換上的裝備有染色表就開放染色、染劑從不染開始 */
  async equip(slot, item) {
    const report = await this.equipLayer.equip(slot, item);
    delete this.stains[slot];
    if (Object.values(this.extraColorsets).some(c => c.dyeTable && c.equip === slot)) this.stains[slot] = [0, 0];
    return report;
  }

  /**
   * 載入外貌（c＝decodeCustomize 結果；整個角色重建）。opts 見 equip.js appearance（verify＝驗證用）。
   * 有染色表的欄保留目前染劑、新開放的欄從不染開始；沒有染色表的欄拿掉染劑
   */
  async appearance(c, opts) {
    const out = await this.equipLayer.appearance(c, opts);
    const dyeable = new Set(Object.values(this.extraColorsets).filter(x => x.dyeTable).map(x => x.equip));
    for (const slot of Object.keys(this.stains)) if (!dyeable.has(slot)) delete this.stains[slot];
    for (const slot of dyeable) this.stains[slot] ??= [0, 0];
    return out;
  }

  /** 預設角色的外貌（equip.js defaultLook；要先選遊戲資料夾） */
  async defaultLook(code) { return this.equipLayer.defaultLook(code); }

  /** 目前種族在角色製作畫面穿的服裝（欄 → { set, variant }；set 0＝沒穿）；還沒有角色＝null */
  get presetOutfit() { return this.equipLayer?.preset ?? null; }

  /** 轉軸（世界 xz）：重建整個角色時依新角色算（equip.js apply），否則用建置時的 */
  get pivot() { return this.equipLayer?.frame?.pivot ?? this.g.pivot; }

  /** 角色在畫面上的範圍 [u0, v0, u1, v1]（任何轉角都包得住）：同上 */
  get screen() { return this.equipLayer?.frame?.screen ?? this.g.screen; }

  async cameraRotation(op) {
    const cam = op.vsCbs[op.rotate.camera];
    const stamp = `${cam.file}|${op.rotate.mainToWorld}|${this.pivot}|${this.theta}`;
    const cached = this.cameraCache.get(cam.file);
    if (cached?.stamp === stamp) return cached.matrix;
    // 著色器宣告的大小可能不含 m_MainViewToWorldMatrix（陰影 VS 只用到前 26 個 float4）：直接讀擷取檔（整份常數緩衝）
    const b = await this.r.bytesOf({ file: cam.file });
    if (b.byteLength < op.rotate.mainToWorld + 48) throw new Error(`#${op.i} 的相機常數緩衝只有 ${b.byteLength} bytes，缺 m_MainViewToWorldMatrix`);
    const matrix = viewRotation(new Float32Array(Uint8Array.from(b.subarray(0, op.rotate.mainToWorld + 48)).buffer), op.rotate.mainToWorld, this.pivot, this.theta);
    this.cameraCache.set(cam.file, { stamp, matrix });
    return matrix;
  }

  /** 原始資料不可改寫；旋轉函式自建輸出，投影函式一律先 slice。 */
  async sourceCb(file, size) {
    let bySize = this.sourceCbs.get(file);
    if (bySize?.has(size)) return bySize.get(size);
    const source = await this.r.bytesOf({ file });
    let bytes;
    if (source.byteLength >= size) bytes = source.subarray(0, size);
    else { bytes = new Uint8Array(size); bytes.set(source); }
    if (!bySize) this.sourceCbs.set(file, bySize = new Map());
    bySize.set(size, bytes);
    return bytes;
  }

  /**
   * 改過的常數緩衝內容只由 stamp 裡的輸入決定（檔案、轉角＋轉軸＋相機、投影裁切）：輸入沒變就直接沿用上次上傳的緩衝。
   * 兩輪重跑的第二輪、以及只改轉角時的背景投影因此不重算不重傳（2026-09-27 量測：森林每幀 JS 約 2／3 花在這裡）。
   */
  async patchCb(op, stage, slot, v) {
    const rot = this.theta !== 0 ? op.rotate : null;
    const inst = rot && (stage === 'VS' ? rot.vsInstance : rot.psInstance);
    const joint = !!rot && stage === 'VS' && slot === rot.joint;
    const head = !joint && !!inst && slot === inst.slot && inst.headUp + 12 <= v.size; // 著色器沒讀到的範圍不改
    const proj = this.crop && op.project?.find(p => p.stage === stage && p.slot === slot);
    if (!joint && !head && !proj) return null;
    const stamp = `${v.file}|${v.size}|${joint ? `J${this.theta}|${this.pivot}|${op.vsCbs[rot.camera].file}` : head ? `H${this.theta}` : ''}|${proj ? this.cropKey : ''}`;
    const key = `${op.i}|${stage}|${slot}`;
    const cached = this.buffers.get(key);
    if (cached?.op === op && cached.stamp === stamp) return cached.buf;
    let out = null;
    if (joint) out = rotateJoints(await this.sourceCb(v.file, v.size), await this.cameraRotation(op));
    else if (head) out = rotateDirectionAt(await this.sourceCb(v.file, v.size), inst.headUp, this.theta);
    if (proj) out = await this.cropProjection(out ?? (await this.sourceCb(v.file, v.size)).slice(), proj);
    const gl = this.r.gl, buf = cached?.buf ?? gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, buf);
    if (cached?.size === out.byteLength) gl.bufferSubData(gl.UNIFORM_BUFFER, 0, out);
    else gl.bufferData(gl.UNIFORM_BUFFER, out, gl.DYNAMIC_DRAW);
    this.buffers.set(key, { buf, size: out.byteLength, stamp, op });
    return buf;
  }

  /**
   * 畫面狀態：zoom＝投影放大倍數（1～4）；center＝放在畫布正中央的原畫面點 [u, v]（0～1，v 由上而下）。
   * 放大時 center 夾在角色範圍（任何轉角都包得住）內，頭頂到腳底都能移到畫面中央；1× 固定看整個原畫面。
   * 不改任何狀態；center 省略＝角色範圍中心。
   */
  clampView({ zoom, center }) {
    const z = Math.max(1, Math.min(4, zoom));
    if (z <= 1) return { zoom: 1, center: [0.5, 0.5] };
    const [u0, v0, u1, v1] = this.screen;
    const [u, v] = center ?? [(u0 + u1) / 2, (v0 + v1) / 2];
    return { zoom: z, center: [Math.max(u0, Math.min(u1, u)), Math.max(v0, Math.min(v1, v))] };
  }

  /** 套用 clampView 後的畫面狀態並回傳；只在整幀重跑之前呼叫（裁切矩陣不可在重跑中途改變）。 */
  setView(state) {
    const view = this.clampView(state);
    this.activeView = view;
    // 曲面細分繪圖畫的是已投影的 DS 輸出，另在 tess.js 的 VS 左乘同一個 K。
    if (view.zoom <= 1) { this.crop = null; this.cropKey = ''; this.r.clipCrop = null; return view; }
    const z = view.zoom;
    const cx = 2 * view.center[0] - 1, cy = 1 - 2 * view.center[1]; // 畫布中央對應的原畫面點（NDC）
    const K = Float64Array.from([z, 0, 0, -z * cx, 0, z, 0, -z * cy, 0, 0, 1, 0, 0, 0, 0, 1]);
    const Kinv = Float64Array.from([1 / z, 0, 0, cx, 0, 1 / z, 0, cy, 0, 0, 1, 0, 0, 0, 0, 1]);
    this.crop = { K, Kinv };
    this.cropKey = `${z}|${view.center}`;
    this.r.clipCrop = K;
    return view;
  }

  /** 主畫面投影相關欄位左乘／右乘裁切矩陣 K：clip' = K·clip（陰影 pass 的相機不動） */
  async cropProjection(bytes, p) {
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
    if (p.kind === 'camera') {
      this.mainInverseView ??= await this.findMainInverseView();
      if (p.inverseView == null || p.inverseView + 48 > bytes.byteLength) return bytes;
      for (let k = 0; k < 12; k++) if (Math.abs(f[p.inverseView / 4 + k] - this.mainInverseView[k]) > 1e-6) return bytes; // 陰影燈的相機
    }
    const { K, Kinv } = this.crop;
    const mat = (o) => Float64Array.from(f.subarray(o / 4, o / 4 + 16));
    const put = (o, m) => f.set(m, o / 4);
    for (const [name, o] of Object.entries(p.fields)) {
      if (o + 64 > bytes.byteLength) continue; // 著色器沒讀到的範圍
      const M = mat(o);
      if (/^m_Inverse(View)?Projection/.test(name)) put(o, mul4(M, Kinv));
      else if (name === 'm_ProjToProjPrevMatrix') put(o, mul4(mul4(K, M), Kinv));
      else put(o, mul4(K, M));
    }
    return bytes;
  }

  /** 主畫面的 inverse view（任一筆主畫面角色繪圖的 m_MainViewToWorldMatrix） */
  async findMainInverseView() {
    const op = [...this.opByI.values()].find(o => o.rotate);
    const b = await this.r.bytesOf({ file: op.vsCbs[op.rotate.camera].file });
    return new Float32Array(Uint8Array.from(b.subarray(op.rotate.mainToWorld, op.rotate.mainToWorld + 48)).buffer);
  }

  /** 每次重跑前：接縫頂點（視空間）依轉角重算、色表依染劑重算 */
  async applyInputs() {
    const r = this.r, gl = r.gl;
    for (const [res, { op: i }] of Object.entries(this.g.rotateBuffers)) {
      const op = this.opByI.get(i);
      const bytes = await r.bytesOf(this.m.resources[res].init);
      if (r.tex[res]?.structured) gl.deleteTexture(r.tex[res].tex);
      r.tex[res] = r.structured(this.theta ? rotateConnection(bytes, await this.cameraRotation(op)) : bytes);
    }
    for (const [res, c] of Object.entries(this.g.colorsets)) {
      if (!c.verified || !c.dyeTable || !r.tex[res]) continue;
      const base = new Uint16Array(Uint8Array.from(await r.bytesOf({ file: c.file })).buffer);
      const stains = this.stains[c.equip] ?? [0, 0];
      const table = stains.some(Boolean) ? applyDye(base, c.width * 4, Uint32Array.from(c.dyeTable), stains, c.shader === 'characterlegacy.shpk' ? this.stm.legacy : this.stm.gud) : base;
      r.scratch();
      gl.bindTexture(gl.TEXTURE_2D, r.tex[res].tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, c.width, c.height, gl.RGBA, gl.HALF_FLOAT, table);
    }
    for (const [res, c] of Object.entries(this.extraColorsets)) {
      if (!r.tex[res]) continue;
      const stains = this.stains[c.equip] ?? [0, 0];
      const table = c.dyeTable && stains.some(Boolean) ? applyDye(c.base, c.width * 4, c.dyeTable, stains, c.shader === 'characterlegacy.shpk' ? this.stm.legacy : this.stm.gud) : c.base;
      r.scratch();
      gl.bindTexture(gl.TEXTURE_2D, r.tex[res].tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, c.width, c.height, gl.RGBA, gl.HALF_FLOAT, table);
    }
  }

  /** 快速互動沿用上一幀歷史、只跑一輪；停下時走原本兩輪，保留靜止畫質。 */
  async render({ degrees = this.theta * 180 / Math.PI, stains, interactive = false } = {}) {
    this.theta = degrees * Math.PI / 180;
    if (stains) Object.assign(this.stains, stains);
    const t0 = performance.now();
    if (this.g.primeHistory && !interactive) await this.r.run();
    await this.r.run(interactive ? INTERACTIVE_SKIP : undefined);
    this.r.gl.finish();
    this.renderedView = this.activeView ?? { zoom: 1, center: [0.5, 0.5] };
    return performance.now() - t0;
  }

  /** 顯示卡名稱（確認有沒有用到硬體加速） */
  get renderer() {
    const gl = this.r.gl, ext = gl.getExtension('WEBGL_debug_renderer_info');
    return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  }

  /** 互動平移／縮放只在最後完成的貼圖上取樣；靜止後仍依新投影完整重播。 */
  present(target) {
    const base = this.renderedView;
    if (!target || !base) { present(this.r, this.m.final.res); return; }
    const scale = base.zoom / target.zoom;
    const x = 0.5 + base.zoom * (target.center[0] - base.center[0]);
    const y = 0.5 + base.zoom * (target.center[1] - base.center[1]);
    present(this.r, this.m.final.res, [x - scale / 2, y - scale / 2, x + scale / 2, y + scale / 2]);
  }
}
