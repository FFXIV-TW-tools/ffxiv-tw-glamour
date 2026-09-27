// 角色外貌：外貌參數（CustomizeData 26 bytes）解碼、種族 → 模型編號、human.cmp 色盤與身高。
// 外貌參數索引對照 Penumbra CustomizeIndex；色盤版面對照 CmpData，但台服 7.2 的 human.cmp 為 178,560 bytes，
// 比 Penumbra 結構少了 4 組未使用色盤（每組參數 1,280 色而非 2,304 色）——2026-09-25 以檔案大小與實際色值推得。
// 手選模式只用色盤的預設色；匯入 glamour.json 時色值改用遊戲 constant buffer（見 glamour.js）。
export const CMP_PATH = 'chara/xls/charamake/human.cmp';

export const RACE_CODE = { // [種族][性別] → 模型種族碼；人族依部族分中原／高地
  1: [[101, 201], [301, 401]], 2: [501, 601], 3: [1101, 1201], 4: [701, 801],
  5: [901, 1001], 6: [1301, 1401], 7: [1501, 1601], 8: [1701, 1801],
};

/** 模型種族碼找不到裝備模型時的替代鏈（Penumbra RaceEnumExtensions.Fallback）。 */
export function fallbackChain(code) {
  const chain = [code];
  while (code !== 101) {
    if (code === 201) code = 101;
    else if (code === 1501) code = 901;
    else if (code === 1201) code = 1101;
    else code = (Math.floor(code / 100) & 1) === 0 ? 201 : 101;
    chain.push(code);
  }
  return chain;
}

export const hasTail = (race) => race === 4 || race === 6 || race === 7;

export function raceCode(race, clan, gender) {
  const entry = RACE_CODE[race];
  const pair = race === 1 ? entry[clan === 2 ? 1 : 0] : entry;
  return pair[gender ? 1 : 0];
}

/** 解析 FFXIV_CHARA_xx.dat（212 bytes，遊戲「保存外貌資料」）→ 外貌參數 26 bytes（版面對照 Penumbra DatCharacterFile）。 */
export function parseCharaDat(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length !== 212 || dv.getUint32(0, true) !== 0x2013ff14) throw new Error('不是遊戲的外貌資料檔（FFXIV_CHARA_xx.dat）');
  return bytes.slice(16, 42);
}

/** CustomizeData 26 bytes → 具名欄位（索引與位元對照 Penumbra CustomizeIndex） */
export function decodeCustomize(c) {
  return {
    race: c[0], gender: c[1], height: c[3], clan: c[4], face: c[5], hair: c[6],
    highlights: !!(c[7] & 0x80), skin: c[8], eye: c[9], hairColor: c[10], highlightColor: c[11],
    features: c[12] & 0x7f, tattooColor: c[13],
    brows: c[14], eyeRight: c[9], eyeLeft: c[15], eyeShape: c[16] & 0x7f, smallIris: !!(c[16] & 0x80), nose: c[17], jaw: c[18], mouth: c[19] & 0x7f,
    lipstick: !!(c[19] & 0x80), lipColor: c[20], tailLength: c[21], tail: c[22], bust: c[23],
    paint: c[24] & 0x7f, paintReversed: !!(c[24] & 0x80), paintColor: c[25],
  };
}

/**
 * 臉部形態鍵：眉 brw、眼 eye、鼻 nse、下顎 chk、嘴 mth 皆「值 0＝原型、n＝第 n 個字母」；小瞳孔 irs_a。
 * 依據：2026-09-25 遊戲匯出（外貌 眉1 眼5 鼻3 顎0 嘴2＋小瞳孔 → 遊戲啟用 brw_a eye_e nse_c mth_b irs_a）。
 * 舊版眉型 +1 是依美容師畫面「類型」編號推的，遊戲資料推翻。
 */
export function faceShapes(c) {
  const shapes = new Set();
  const add = (part, v) => { if (v > 0) shapes.add(`shp_${part}_${String.fromCharCode(96 + v)}`); };
  add('brw', c.brows); add('eye', c.eyeShape); add('nse', c.nose); add('chk', c.jaw); add('mth', c.mouth);
  if (c.smallIris) shapes.add('shp_irs_a');
  return shapes;
}

/**
 * human.cmp（台服 178,560 bytes）。色盤位置 2026-09-25 以遊戲 CustomizeParameter／DecalColor 逐值核對：
 * 共用區 0 瞳色、1024 挑染、2048 唇色、3072 臉部特徵色、4096 臉彩色（各 256 色 × RGBA）；
 * 部族區 10240 起每部族性別 5120 bytes：膚色 v×4、髮色 1024＋v×8（前 4 bytes 髮色、後 4 bytes 髮的菲涅耳色）。
 */
export function parseCmp(bytes) {
  const PARAMS = 0, RACES = 10240, SCALES = 174080;
  if (bytes.length !== 178560) throw new Error(`human.cmp 大小 ${bytes.length} 與已驗證的台服版面不同`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rgba = (off) => [bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]];
  const raceBase = (clan, gender) => RACES + ((clan - 1) * 2 + (gender ? 1 : 0)) * 5120;
  return {
    skin: (clan, gender, v) => rgba(raceBase(clan, gender) + v * 4),
    hair: (clan, gender, v) => rgba(raceBase(clan, gender) + 1024 + v * 8),
    hairFresnel: (clan, gender, v) => rgba(raceBase(clan, gender) + 1024 + v * 8 + 4),
    eye: (v) => rgba(PARAMS + v * 4),
    highlight: (v) => rgba(PARAMS + 1024 + v * 4),
    lip: (v) => rgba(PARAMS + 2048 + v * 4),
    features: (v) => rgba(PARAMS + 3072 + v * 4),
    facePaint: (v) => rgba(PARAMS + 4096 + v * 4),
    /** 身高倍率：依外貌參數 height(0–100) 在部族男女的 min–max 間內插 */
    height(clan, gender, h) {
      const idx = clan - 1;
      const o = SCALES + ((idx >> 1) * 10 + (idx & 1)) * 56 + (gender ? 16 : 0);
      const min = dv.getFloat32(o, true), max = dv.getFloat32(o + 4, true);
      return min + ((max - min) * h) / 100;
    },
    /**
     * 胸圍：j_mune_l/r 的 local 縮放 xyz＝同一列（14 float）float 8–10（min）到 11–13（max）依 bust(0–100) 內插。
     * 2026-09-26 角色製作傾印：11 位女性逐值 ≤2.5e-7；9 位男性 j_mune local 縮放都不是這個值（1，硌獅族男 0）⇒ 男性回傳 null（不作用）。
     */
    bust(clan, gender, b) {
      if (!gender) return null;
      const idx = clan - 1;
      const o = SCALES + ((idx >> 1) * 10 + (idx & 1)) * 56;
      return [0, 1, 2].map((k) => { const min = dv.getFloat32(o + (8 + k) * 4, true), max = dv.getFloat32(o + (11 + k) * 4, true); return min + ((max - min) * b) / 100; });
    },
  };
}

/**
 * 外貌參數 → 遊戲送進 shader 的顏色（與 glamour.js interpretParams 同形狀）。
 * 2026-09-25 對遊戲匯出核對：膚／髮／髮菲涅耳／挑染／瞳／唇／特徵色＝(色盤/255)²；唇不透明度＝色盤 A/255；
 * 臉彩色＝⌊色盤²/255⌋/255（遊戲以 8 位元存平方值），A/255。左右瞳取 CustomizeIndex 的左 15／右 9（本次兩眼同色，左右未能區分）；
 * 臉彩 UV：未反轉 (1, 0) 已核對，反轉 (-1, 1) 未核對。
 */
export function deriveParams(c, cmp) {
  const sq = (p) => [0, 1, 2].map((i) => (p[i] / 255) ** 2);
  const lip = cmp.lip(c.lipColor);
  const paint = cmp.facePaint(c.paintColor);
  return {
    skin: sq(cmp.skin(c.clan, c.gender, c.skin)),
    lip: [...sq(lip), lip[3] / 255],
    hair: sq(cmp.hair(c.clan, c.gender, c.hairColor)),
    hairFresnel: sq(cmp.hairFresnel(c.clan, c.gender, c.hairColor)),
    highlight: sq(cmp.highlight(c.highlightColor)),
    leftEye: [...sq(cmp.eye(c.eyeLeft)), 0],
    rightEye: [...sq(cmp.eye(c.eyeRight)), 0],
    option: sq(cmp.features(c.tattooColor)),
    paintUvMultiplier: c.paintReversed ? -1 : 1,
    paintUvOffset: c.paintReversed ? 1 : 0,
    decalColor: [...[0, 1, 2].map((i) => Math.floor((paint[i] * paint[i]) / 255) / 255), paint[3] / 255],
  };
}

/**
 * 外貌 → CustomizeParameter 常數緩衝（台服 36 float，版面見 glamour.js interpretParams）。
 * 外貌決定的欄位由 deriveParams 算；其餘欄位（膚色菲涅耳、肌肉量、瞳孔邊緣強度…）照 captured（同種族＝擷取值、別的種族＝race-pose 該種族值）。
 * 挑染關＝挑染色設成髮色、唇膏關＝唇色整組 (0,0,0,0)：hair.shpk 以 lerp(髮色 cb[3], 挑染色 cb[5], 遮罩)、
 * skin.shpk 以「唇色 cb[2].w × 遮罩」混色，這樣設畫面即等同沒有（2026-09-26 由兩支著色器反組譯推得；
 * 唇膏關＝RGB 也是 0 由 2026-09-26 09:47 擷取（ShaderProbe human.json＋常數緩衝，唇膏關的角色）逐值核對）。
 * f[7]＝唇膏開 32、關 1：2026-09-26 角色製作傾印＋美容師擷取的 -human.json 共 66 個不重複人型（唇膏開 30、關 36）不給 f[7] 重算，36 欄最大差 8.6e-8。
 */
export function customizeCb(c, cmp, captured) {
  const f = Float32Array.from(captured);
  const p = deriveParams(c, cmp);
  f.set(p.skin, 0);
  f[7] = c.lipstick ? 32 : 1;
  f.set(c.lipstick ? p.lip.slice(0, 3) : [0, 0, 0], 8);
  f[11] = c.lipstick ? p.lip[3] : 0;
  f.set(p.hair, 12);
  f[15] = p.paintUvMultiplier;
  f.set(p.hairFresnel, 16);
  f.set(c.highlights ? p.highlight : p.hair, 20);
  f[23] = p.paintUvOffset;
  f.set(p.leftEye.slice(0, 3), 24);
  f.set(p.rightEye.slice(0, 3), 28);
  f.set(p.option, 32);
  return f;
}

/**
 * 外貌 → 臉的 g_DecalColor（臉彩色）：臉彩色盤值，沒有臉彩時也照填（2026-09-26 擷取核對：臉彩 0 的人型 W 仍是色盤 A，
 * 例 0.5922），臉彩消失是靠換綁透明貼圖（facePaintPath(0)）。
 */
export function decalColorCb(c, cmp, captured) {
  const f = Float32Array.from(captured);
  const { decalColor } = deriveParams(c, cmp);
  f.set(decalColor, 0);
  return f;
}

const pad4 = (n) => String(n).padStart(4, '0');

/**
 * 臉部彩繪貼花（Penumbra GamePaths.FaceDecal；遊戲匯出 臉彩 4 → _decal_4.tex 已核對）。臉彩 0＝chara/common/texture/transparent.tex：
 * 2026-09-26 capture-20260926-092951（可見角色臉彩 0）臉的 g_SamplerDecal 快照 6 層 mip 與此檔逐 byte 相同。
 */
export const facePaintPath = (n) => (n ? `chara/common/texture/decal_face/_decal_${n}.tex` : 'chara/common/texture/transparent.tex');

/** 在已存在的編號中挑：部族偶數者臉型 +100（高地之民也是）；找不到就挑同種族第一個存在的臉。 */
export function faceId(customize, code, exists) {
  const even = customize.clan % 2 === 0;
  const candidates = [customize.face + (even ? 100 : 0), customize.face + (even ? 4 : 0), customize.face];
  for (const f of candidates) if (exists(f)) return f;
  for (let f = 1; f <= 300; f++) if (exists(f)) return f;
  return null;
}

export const facePath = (code, f) => `chara/human/c${pad4(code)}/obj/face/f${pad4(f)}/model/c${pad4(code)}f${pad4(f)}_fac.mdl`;
export const hairPath = (code, h) => `chara/human/c${pad4(code)}/obj/hair/h${pad4(h)}/model/c${pad4(code)}h${pad4(h)}_hir.mdl`;
export const tailPath = (code, t) => `chara/human/c${pad4(code)}/obj/tail/t${pad4(t)}/model/c${pad4(code)}t${pad4(t)}_til.mdl`;
export const earPath = (code, z) => `chara/human/c${pad4(code)}/obj/zear/z${pad4(z)}/model/c${pad4(code)}z${pad4(z)}_zer.mdl`;
