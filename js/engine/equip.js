// 外觀預覽測試版・換裝（網頁端）：依 manifest.game.equip（tools/equip-mode.mjs 產生，規則都已拿本幀驗證），
// 把某個裝備欄換成別件：從玩家 client 讀模型／材質／貼圖／shpk，照「同 pass、同 shpk」的範本繪圖產生新繪圖。
//  - 著色器：材質 key＋範本的系統／場景／子視圖 key → shpk 節點 → 範本那個 pass 的 VS／PS（本幀驗證的選法）；
//    範本的 key 組合有多個候選時逐一試，選到的著色器不同就拒絕；變體沒預先翻譯也拒絕。
//  - 常數緩衝依名稱對應：g_MaterialParameter＝shpk 預設＋mtrl 常數、骨架矩陣＝原生矩陣 · 種族變形、
//    g_ModelParameter.x＝pbd 比例，其餘（相機、實例、自訂色、接縫…）沿用範本。
//  - 額外骨架（頭飾 met、上衣 top、髮型 hair；EST 查 sklb，met/top 用裝備模型實際種族、hair 用角色種族）：和擷取時穿的不是同一個
//    sklb 時，額外骨頭一律用 js/game/est.js rigidExtraJoints「參考姿勢剛性接在主骨架」算原生矩陣（J＝J0[接點]·RefModel0[接點]·inv(RefModel_p[根])，
//    推導與驗證數字見該函式：頭飾／上衣對傾印與 GPU 最大差 ~1e-6；髮型遊戲有物理擺動，最大偏 26°，這裡是靜止姿勢並在報告註明）。
//  - 貼圖：材質 sampler 同 id → mtrl 指的貼圖；g_SamplerTable → mtrl 色表（可染）；其餘沿用範本。
//  - 背面剔除依材質旗標 0x1（本幀驗證：有＝剔背面、無＝不剔）；取樣位址依 mtrl sampler 旗標（Penumbra SamplerFlags）。
//  - 範本沒綁、新著色器要的常數：g_DecalColor 借別的裝備繪圖；其餘看 manifest equip.derivedCbs（建置時由同一幀推、並在同背景擷取逐值驗證），
//    都沒有就拒絕。
//  - 角色（appearance）：擷取角色的所有角色繪圖（裝備、身體零件、臉、髮、尾巴）一律拿掉（GameView 開頁就不畫，不預設顯示擷取的角色），
//    照外貌全部依範本重建——骨架矩陣見 js/game/race.js（J＝V·H·W·B）、裝備依種族 resolveGear（沒換的欄穿該種族角色製作畫面的服裝）、
//    身體零件照 data/race-pose/<模型碼>.json、臉／髮／尾巴／維艾拉耳朵照外貌。細節與「未驗證」處見 appearance() 與 bodyPlan()。
import { parseShpk, materialKeyValues } from '../game/shpk.js';
import { parsePbd, PBD_PATH } from '../game/pbd.js';
import { CMP_PATH, parseCmp, raceCode, hasTail, decodeCustomize, faceId, faceShapes, facePath, hairPath, tailPath, earPath, facePaintPath, customizeCb, decalColorCb } from '../game/customize.js';
import { parseSklb, referenceModel, inverse34 } from '../game/sklb.js';
import { baseSklbPath } from '../game/est.js';
import { RACE_POSE_BASE, bodyJoints, toWorld, framing, emptyBounds } from '../game/race.js';
import { EquipDraws } from './equip-draws.js';
import { SLOT_CODE, PART_NAME, pad4, pathId, passTarget } from './equip-slots.js';

/** 擷取角色的繪圖（建置時的角色網格繪圖＝有 rotate 的網格繪圖）：GameView 一開始就不畫（不預設顯示擷取的角色），角色一律由 appearance() 重建 */
export const isCharacterDraw = (m, o) => o.op === 'draw' && !!o.rotate && m.geometry[o.geometry]?.kind === 'mesh';
export class EquipLayer extends EquipDraws {
  /** @param packs { chara: SqPack(040000), shader: SqPack(050000) } */
  constructor(view, packs) {
    super();
    this.view = view;
    this.r = view.r;
    this.m = view.m;
    this.e = view.g.equip;
    this.packs = packs;
    this.shpks = new Map();
    this.worn = {};       // 欄 → { ops, colorsets, blocks, bounds, preset?, report, 以及要釋放的 files／geometries／tables }
    this.requested = {};  // 使用者換上的裝備（欄 → item）；換種族時依新種族重做
    this.body = null;     // 目前的角色 { code, c, outfit?, partial? }；appearance() 之前＝null（還沒有角色）
    this.preset = null;   // 目前種族在角色製作畫面穿的服裝（data/race-pose/<模型碼>.json equipment）：沒換的欄穿這套
    this.frame = null;    // 角色的轉軸與畫面範圍（js/game/race.js framing）；null＝還沒有角色，用建置時的
    this.generation = 0;  // 每次換裝一個新代號：虛擬檔名、幾何鍵都不重複（FrameReplay 以檔名快取 UBO／VAO）
    this.cbSwap = new Map(); // 載入外貌：擷取的常數緩衝檔 → 換上的虛擬檔（CustomizeParameter、臉彩色）
    this.cbFiles = [];       // 上面那些虛擬檔（恢復時釋放）
    this.baseOps = view.fullOps.slice(); // 建置時的全部操作（含擷取角色；GameView 畫面上已拿掉角色繪圖）
    this.opByI = new Map(this.baseOps.map(o => [o.i ?? o.at, o]));
    this.templates = Object.entries(this.e.templates).map(([i, t]) => ({ ...t, op: this.opByI.get(Number(i)) }));
    // 擷取角色的全部繪圖（建置時的角色網格繪圖＝有 rotate 的網格繪圖），以及其中不屬於任何欄的（身體零件 13–15）
    this.characterOps = this.baseOps.filter(o => isCharacterDraw(this.m, o));
    const inSlot = new Set(Object.values(this.e.slots).flatMap(s => s.ops));
    this.capturedBodyOps = this.characterOps.filter(o => !inSlot.has(o.i));
    this.skel = this.capturedSkeleton();
    this.baseSkeletons = new Map();
    this.racePoseData = new Map();
  }

  async init() {
    this.pbd = parsePbd(await this.read(PBD_PATH));
    const op = this.characterOps.find(o => o.rtvs.length >= 4); // G-pass（主畫面相機；同 tools/game-mode.mjs 取景）
    const cam = new Float32Array(Uint8Array.from(await this.r.bytesOf({ file: op.vsCbs[op.rotate.camera].file })).buffer);
    this.mainToWorld = Float64Array.from(cam.subarray(op.rotate.mainToWorld / 4, op.rotate.mainToWorld / 4 + 12));
    this.camera = { C: cam, vp: op.rotate.viewProj / 4 };
    return this;
  }

  /** 擷取的角色：骨架＝擷取／姿勢傾印；source＝擷取時穿戴的額外骨架來源（EST 判斷要不要剛性補） */
  capturedSkeleton() {
    const e = this.e;
    return {
      code: e.skeletonRace, bones: e.bones, bonesPrev: e.bonesPrev, captured: e.captured, tail: e.tail,
      source: { hair: e.customize.bytes[6], face: pathId(e.slots.Face?.model, 'f'), Head: e.original?.Head?.set, Top: e.original?.Top?.set },
    };
  }

  async read(path) {
    const bytes = await this.packs.chara.read(path);
    if (!bytes) throw new Error(`client 裡找不到 ${path}`);
    return bytes;
  }

  async shpk(name) {
    if (!this.shpks.has(name)) {
      const bytes = await this.packs.shader.read(`shader/sm5/shpk/${name}.shpk`);
      if (!bytes) throw new Error(`client 裡找不到 ${name}.shpk`);
      this.shpks.set(name, parseShpk(bytes));
    }
    return this.shpks.get(name);
  }

  /** 可換裝的欄（部位列用）；外貌部位由 appearance() 換 */
  get slots() { return Object.keys(SLOT_CODE); }

  /** 角色製作畫面這個種族穿的服裝（set 0＝那一欄沒穿）；沒換的欄穿這套 */
  presetItem(slot) {
    const o = this.preset?.[slot];
    return o?.set ? { set: o.set, variant: o.variant, preset: true } : null;
  }

  /** 這一欄要穿的：驗證模式照指定裝備；否則使用者換上的，沒有就預設服裝 */
  gearItem(slot) {
    if (this.body?.outfit) return this.body.outfit[slot] ?? null;
    return this.requested[slot] ?? this.presetItem(slot);
  }

  /** item＝{ set, variant, blocks? }；null＝恢復預設服裝。回傳換裝報告（字串陣列）；換不上去時維持原狀並丟例外 */
  async equip(slot, item) {
    if (!this.body) throw new Error('角色還沒建好（先載入外貌）');
    const want = item ?? this.presetItem(slot);
    const next = want ? await this.build(slot, want) : null;
    if (item) this.requested[slot] = item;
    else delete this.requested[slot];
    const prev = this.worn[slot];
    if (next) this.worn[slot] = next;
    else delete this.worn[slot];
    this.apply();
    if (prev) this.dispose(prev);
    return item ? next.report : [`${slot}：恢復預設服裝${next ? `（c${pad4(this.skel.code)}）` : '（這個種族這一欄沒穿）'}`];
  }

  /** 預設外貌：可指定模型碼；只讀所選種族的角色製作畫面資料。 */
  async defaultLook(code = this.e.skeletonRace) {
    const rp = await this.racePose(code);
    return decodeCustomize(Uint8Array.from(rp.customize));
  }

  /** 逐模型讀取並快取姿勢資料；切換種族時不下載其餘 17 份。 */
  racePose(code) {
    const key = pad4(code), url = `${RACE_POSE_BASE}${key}.json`;
    if (!this.racePoseData.has(key)) this.racePoseData.set(key, fetch(url, { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error(`讀不到 ${url}（${r.status}）`); return r.json(); })
      .catch(e => { this.racePoseData.delete(key); throw e; }));
    return this.racePoseData.get(key);
  }

  /** 主骨架 sklb（剛性接額外骨架、胸圍的 RefModel 用），依種族快取 */
  async baseSkeleton(code) {
    if (!this.baseSkeletons.has(code)) {
      this.baseSkeletons.set(code, (async () => { const s = parseSklb(await this.read(baseSklbPath(code))); return { s, ref: referenceModel(s) }; })());
    }
    return this.baseSkeletons.get(code);
  }

  /**
   * 重建整個角色用的骨架（js/game/race.js 公式）。同種族（且不是驗證模式）用擷取角色自己的姿勢，只改身高／胸圍；
   * 別的種族用 race-pose 那個種族在角色製作畫面的姿勢（靜止一幀：上一幀＝本幀）。
   * @param verify 驗證模式：{ view: 12 float 視矩陣（取代背景包的 V）}，一律用 race-pose 姿勢
   */
  async bodySkeleton(c, code, verify) {
    const e = this.e, cmp = this.cmp;
    const base = await this.baseSkeleton(code);
    const bustRatio = (from) => {
      const to = cmp.bust(c.clan, c.gender, c.bust), was = cmp.bust(from.clan, from.gender, from.bust);
      return to && was ? { ratio: to.map((v, k) => v / was[k]), ref: (b) => base.ref[base.s.bones.indexOf(b)] } : null;
    };
    const height = cmp.height(c.clan, c.gender, c.height);
    if (!verify && code === e.skeletonRace) {
      const cap = decodeCustomize(Uint8Array.from(e.customize.bytes));
      const k = height / cmp.height(cap.clan, cap.gender, cap.height), bust = bustRatio(cap), V = inverse34(this.mainToWorld);
      return {
        ...this.capturedSkeleton(), captured: null, pose: '擷取角色自己的姿勢',
        bones: bodyJoints(toWorld(e.bones, this.mainToWorld), V, k, bust), bonesPrev: bodyJoints(toWorld(e.bonesPrev, this.mainToWorld), V, k, bust),
      };
    }
    const rp = await this.racePose(code);
    const rc = decodeCustomize(Uint8Array.from(rp.customize));
    const rpHeight = cmp.height(rc.clan, rc.gender, rc.height);
    if (Math.abs(rp.skeleton[7] - rpHeight) > 1e-5) throw new Error(`race-pose c${pad4(code)} 的骨架縮放 ${rp.skeleton[7]} 與 human.cmp 身高 ${rpHeight} 不符`);
    const bones = bodyJoints(rp.bones, verify?.view ?? inverse34(this.mainToWorld), height / rp.skeleton[7], bustRatio(rc));
    return {
      code, bones, bonesPrev: bones, captured: null, tail: hasTail(c.race), pose: `角色製作畫面 c${pad4(code)} 的姿勢（${rp.source}）`,
      source: { hair: rc.hair, face: pathId(rp.models.find(m => m.slot === 11)?.path, 'f'), Head: rp.equipment?.Head?.set, Top: rp.equipment?.Top?.set },
      customizeParameter: rp.customizeParameter,
    };
  }

  /**
   * 身體零件（角色描述 slot 13–15，data/race-pose/<模型碼>.json models）要畫哪幾欄、畫在哪幾輪：照擷取的這一幀——
   * 擷取角色的身體零件繪圖（不屬於任何欄的角色繪圖）是哪一欄的模型、畫在哪幾輪輸出（範本 passKey）。
   * 本幀（室內，c0801）只畫了 14 欄 c0801b0002_top（atr_cn_neck）的 G-pass 與一輪半透明前的輸出；13、15 欄整個沒畫、也不畫陰影。
   * 遊戲何時顯示 13／15 欄與各 atr_cn_* 子網格（連接處補丁）的規則沒推出來（未驗證），所以只畫擷取這一幀畫過的欄。
   * 範本：同一輪輸出（passKey）、同 shpk、且用擷取那筆身體零件的材質選得回它的 VS／PS 的那一筆（場景 key 屬於物件：
   * 本幀同一輪的 Top 皮膚範本選到 skin-ps36、Arms 皮膚範本選到 ps6＝擷取值），都選不回就拒絕。
   */
  async bodyPlan(code) {
    if (!this.bodyPasses) {
      const cap = await this.racePose(this.e.skeletonRace);
      const slots = new Set(), templates = new Map();
      for (const o of this.capturedBodyOps) {
        const g = this.m.geometry[o.geometry];
        const slot = cap?.models.find(m => m.path === g.model)?.slot;
        if (slot == null) throw new Error(`擷取角色的身體零件 #${o.i} ${g.model} 不在 race-pose c${pad4(this.e.skeletonRace)} 的模型清單`);
        slots.add(slot);
        const target = passTarget(o);
        let last = null;
        for (const x of this.templates) if (x.op && x.op.i < o.i && x.passKey.startsWith(`${target}#`) && (!last || x.op.i > last.op.i)) last = x;
        if (!last) throw new Error(`身體零件 #${o.i} 找不到同一輪輸出的範本`);
        const mat = await this.material(g.material, 1, this.e.skeletonRace);
        const shpk = await this.shpk(mat.pkg), mk = materialKeyValues(shpk, mat.mtrl.keyList);
        const tried = [];
        const t = this.templates.find(x => {
          if (x.passKey !== last.passKey || x.shpk !== mat.pkg) return false;
          let pick = null;
          try { pick = this.pickShaders(shpk, x, mk); } catch { /* 範本 key 不唯一：不選它 */ }
          tried.push(`#${x.op.i}${pick ? `→${pick.ps}` : ''}`);
          return pick?.vs === o.vs && pick?.ps === o.ps;
        });
        if (!t) throw new Error(`身體零件 #${o.i}（${o.vs}/${o.ps}）：同一輪的範本都選不回擷取的著色器（${tried.join('、')}）`);
        templates.set(`${t.passKey}|${t.pass}`, t);
      }
      this.bodyPasses = { slots: [...slots].sort(), templates: [...templates.values()] };
    }
    const rp = await this.racePose(code);
    return this.bodyPasses.slots.map(s => rp.models.find(m => m.slot === s)).filter(Boolean)
      .map(m => ({ slot: `Body${m.slot}`, item: { path: m.path, code: Number(/\/c(\d{4})b\d{4}_\w+\.mdl$/.exec(m.path)[1]), body: true } }));
  }

  /**
   * 載入外貌（c＝js/game/customize.js decodeCustomize）：整個角色重建——擷取角色的所有角色繪圖拿掉，骨架照 bodySkeleton
   * （同種族用擷取角色的姿勢、只改身高／胸圍；別的種族用 race-pose 該種族在角色製作畫面的姿勢）、
   * 裝備（使用者換上的，沒換的欄穿該種族角色製作畫面的服裝）依新種族 resolveGear、身體零件照 bodyPlan、臉／髮／尾巴／耳朵照外貌；
   * 裝備若只有部分網格缺著色器範本，保留可驗證的網格並警告；整件無可重播繪圖則拒絕。
   * CustomizeParameter 與臉彩色整份換掉（非外貌欄位：別的種族用 race-pose 該種族的值）。
   * 皮膚與縫合處：g_InputConnectionVertex（接縫吸附點，遊戲以擷取角色的網格算好）換成空的（半徑 −1，著色器不吸附）。
   * @param verify 驗證用：{ view, outfit, partial }——view 取代背景包的視矩陣（例：角色製作相機）、outfit＝各欄裝備（沒列＝不穿）、
   *   partial＝即使整件裝備的全部網格都缺範本仍允許空模型（列警告）；姿勢一律用 race-pose
   */
  async appearance(c, { verify } = {}) {
    const e = this.e;
    this.cmp ??= parseCmp(await this.read(CMP_PATH));
    const code = raceCode(c.race, c.clan, c.gender);
    const rp = await this.racePose(code);
    const prevSkel = this.skel, prevBody = this.body, prevPreset = this.preset;
    const built = {}, warnings = [], kept = [];
    const drop = (err) => { for (const w of Object.values(built)) this.dispose(w); this.skel = prevSkel; this.body = prevBody; this.preset = prevPreset; throw err; };
    try {
      this.body = { code, c, outfit: verify?.outfit, partial: !!verify?.partial };
      this.preset = rp.equipment;
      this.skel = await this.bodySkeleton(c, code, verify);
      for (const slot of Object.keys(SLOT_CODE)) {
        const item = this.gearItem(slot);
        if (!item) continue;
        try { built[slot] = await this.build(slot, item); } catch (err) {
          warnings.push(`${slot}（${item.set}-${item.variant}）依 c${pad4(code)} 重建失敗，這欄先不畫：${err.message}`);
        }
      }
      for (const { slot, item } of await this.bodyPlan(code)) built[slot] = await this.build(slot, item);
    } catch (err) { drop(err); }
    const has = (p) => this.packs.chara.has(p);
    const f = faceId(c, code, (id) => has(facePath(code, id)));
    if (f == null) drop(new Error(`c${code} 找不到任何臉型模型`));
    const parts = {
      Hair: { path: hairPath(code, c.hair), code, estSet: c.hair },
      Face: { path: facePath(code, f), code, estSet: f, shapes: [...faceShapes(c)], features: c.features, decal: facePaintPath(c.paint) },
      ...(this.skel.tail ? { Tail: { path: tailPath(code, c.tail), code } } : {}),
      ...(c.race === 8 ? { Zear: { path: earPath(code, c.tail), code } } : {}),
    };
    for (const [slot, p] of Object.entries(parts)) if (!has(p.path)) drop(new Error(`${PART_NAME[slot]}：client 裡沒有 ${p.path}`));
    // 額外骨頭：臉／髮型用 EST 額外骨架剛性補（buildInto → extraBones）；補完仍缺姿勢的部位（EST 沒有這筆或 sklb 不在 client）不畫，列在警告
    try {
      for (const [slot, p] of Object.entries(parts)) {
        try {
          built[slot] = await this.build(slot, p);
        } catch (err) {
          if (!err.missingBones) throw err;
          kept.push(`${err.message}；這個部位先不畫`);
        }
      }
    } catch (err) { drop(err); }
    // 常數緩衝：CustomizeParameter／臉彩色（別的種族：非外貌欄位用 race-pose 該種族值）
    const gen = ++this.generation;
    const cbSwap = new Map(), cbFiles = [];
    for (const [file, make, own] of [[e.customize.cb, customizeCb, this.skel.customizeParameter], [e.customize.decal, decalColorCb, null]]) {
      const base = new Float32Array((await this.r.cbBytes(file, 256)).buffer);
      if (own) base.set(own.slice(0, 36));
      const name = `cz/${gen}-${file.split('/').pop()}`;
      this.r.provide(name, new Uint8Array(make(c, this.cmp, base).buffer));
      cbSwap.set(file, name);
      cbFiles.push(name);
    }
    const prevWorn = this.worn, prevFiles = this.cbFiles;
    this.worn = built;
    this.cbSwap = cbSwap;
    this.cbFiles = cbFiles;
    this.apply();
    for (const w of Object.values(prevWorn)) this.dispose(w);
    this.dispose({ files: prevFiles, geometries: [], tables: [] });
    const id = (slot, prefix, n) => `${prefix}${pad4(n)}${parts[slot] && !built[slot] ? '（沒畫）' : ''}`;
    const report = [`外貌：c${pad4(code)}（骨架＝${this.skel.pose}，身高 ${c.height}${c.gender ? `、胸圍 ${c.bust}` : ''}）；臉型 ${id('Face', 'f', f)}、髮型 ${id('Hair', 'h', c.hair)}${parts.Tail ? `、尾巴 ${id('Tail', 't', c.tail)}` : ''}${parts.Zear ? `、耳朵 ${id('Zear', 'z', c.tail)}` : ''}；顏色由外貌＋human.cmp 算`];
    report.push(`  身體零件：${Object.keys(built).filter(s => s.startsWith('Body')).map(s => built[s].report[0].replace(/^\w+：/, '')).join('、') || '（無）'}；接縫吸附（g_InputConnectionVertex）關閉`);
    warnings.push(...kept, ...Object.values(built).flatMap(w => w.warnings));
    for (const w of Object.values(built)) report.push(...w.report);
    return { report, warnings };
  }

  /** 釋放換下來的那件的 GL 資源與虛擬檔 */
  dispose(w) {
    const r = this.r, gl = r.gl;
    for (const file of w.files) {
      r.byteCache?.delete(r.base + file);
      this.view.sourceCbs.delete(file);
      this.view.cameraCache.delete(file);
      for (const k of Object.keys(r.ubos)) if (k.startsWith(`${file}|`)) { r.ubos[k].then(b => gl.deleteBuffer(b)); delete r.ubos[k]; }
    }
    for (const key of w.geometries) {
      for (const k of Object.keys(r.vaos)) if (k.endsWith(`|${key}`)) { gl.deleteVertexArray(r.vaos[k].vao); delete r.vaos[k]; }
      delete this.m.geometry[key];
    }
    for (const res of w.tables) { gl.deleteTexture(r.tex[res].tex); delete r.tex[res]; }
  }

  provide(w, file, bytes) {
    this.r.provide(file, bytes);
    w.files.push(file);
  }

  /**
   * 依目前的角色重排整幀的操作：擷取角色的角色繪圖全部拿掉，新繪圖插在各自範本之後；
   * 預設服裝的欄被別件遮住（blocks）就不畫；轉軸與畫面範圍依新角色重算。
   */
  apply() {
    const removed = new Set(this.characterOps.map(o => o.i)), hidden = new Set();
    const blocks = new Set(Object.values(this.worn).flatMap(w => w.blocks));
    for (const [slot, w] of Object.entries(this.worn)) if (w.preset && blocks.has(slot)) hidden.add(slot);
    const shown = Object.entries(this.worn).filter(([slot]) => !hidden.has(slot)).map(([, w]) => w);
    const after = new Map();
    for (const w of shown) for (const op of w.ops) {
      const list = after.get(op.after) ?? after.set(op.after, []).get(op.after);
      list.push(op);
    }
    const ops = [];
    const swap = (cbs) => {
      if (!cbs || !Object.values(cbs).some(v => this.cbSwap.has(v?.file))) return cbs;
      const out = Array.isArray(cbs) ? cbs.slice() : { ...cbs };
      for (const k of Object.keys(out)) if (this.cbSwap.has(out[k]?.file)) out[k] = { ...out[k], file: this.cbSwap.get(out[k].file) };
      return out;
    };
    const put = (op) => {
      if (op.op !== 'draw' || !this.cbSwap.size) { ops.push(op); return; }
      const vsCbs = swap(op.vsCbs), psCbs = swap(op.psCbs);
      ops.push(vsCbs === op.vsCbs && psCbs === op.psCbs ? op : { ...op, vsCbs, psCbs });
    };
    for (const op of this.baseOps) {
      const i = op.i ?? op.at;
      if (!removed.has(i)) put(op);
      for (const extra of after.get(i) ?? []) put(extra);
    }
    this.m.ops = ops;
    this.view.extraColorsets = Object.assign({}, ...shown.map(w => w.colorsets));
    const b = emptyBounds();
    for (const w of shown) for (const k of ['minX', 'minY', 'minZ']) b[k] = Math.min(b[k], w.bounds[k]);
    for (const w of shown) for (const k of ['maxX', 'maxY', 'maxZ']) b[k] = Math.max(b[k], w.bounds[k]);
    this.frame = Number.isFinite(b.minX) ? framing(b, this.camera.C, this.camera.vp) : null;
  }

}
