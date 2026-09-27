import { CMP_PATH, parseCmp, raceCode, hasTail, hairPath, tailPath, earPath, facePaintPath } from '../game/customize.js';

const cache = new Map();
export const modelCode = (c) => String(raceCode(c.race, c.clan, c.gender)).padStart(4, '0');
/** 只檢查引擎實際讀取的玩家遊戲檔案；無獨立路徑的臉型仍交由引擎 faceId 處理。 */
export function choicePath(c, field, id) {
  if (field === 'paint') return facePaintPath(id);
  if (field !== 'hair' && field !== 'tail') return null;
  const code = raceCode(c.race, c.clan, c.gender);
  if (field === 'hair') return hairPath(code, id);
  if (hasTail(c.race)) return tailPath(code, id);
  if (c.race === 8) return earPath(code, id);
  return null;
}

export async function charamake(c) {
  const code = modelCode(c);
  if (!cache.has(code)) cache.set(code, fetch(`./data/charamake/c${code}.json`)
    .then((r) => { if (!r.ok) throw new Error(`讀不到角色製作選項（${code}）`); return r.json(); })
    .catch((e) => { cache.delete(code); throw e; }));
  const variants = await cache.get(code);
  const result = variants[`${c.clan}-${c.gender}`];
  if (!result) throw new Error(`沒有這個部族與性別的角色製作選項（${code}）`);
  return result;
}

export async function colourPalette(view) {
  return view.equipLayer.cmp ?? parseCmp(await view.equipLayer.packs.chara.read(CMP_PATH));
}

// 唇色、面妝的 96 個顏色各有 0–95 與 128–223 兩組；其餘色票從 0 起連續編號。
export function colourIds(field, count) {
  if ((field === 'lipColor' || field === 'paintColor') && count > 5) {
    return [...Array(count).keys(), ...Array.from({ length: count }, (_, n) => n + 128)];
  }
  return [...Array(count).keys()];
}

export function rgbaCss(rgba) { return `rgb(${rgba[0]} ${rgba[1]} ${rgba[2]})`; }

export function swatchColour(cmp, palette, c, id) {
  if (palette === 'clanSkin') return cmp.skin(c.clan, c.gender, id);
  if (palette === 'clanHair') return cmp.hair(c.clan, c.gender, id);
  return cmp[palette](id);
}

export function invalidOptions(c, data) {
  const notes = [];
  const checkList = (field, options, label) => {
    if (options && !options.some((o) => o.id === c[field])) notes.push(`${label} ${c[field]} 不在此角色的選項中，請改選其他項目。`);
  };
  checkList('face', data.faces?.options, data.faces?.label ?? '臉型');
  checkList('hair', data.hair?.options, data.hair?.label ?? '髮型');
  checkList('paint', data.facePaint?.options, data.facePaint?.label ?? '面妝');
  checkList('tail', data.raceFeature?.options, data.raceFeature?.label ?? '尾巴／耳朵');
  for (const [field, range] of Object.entries(data.ranges)) {
    if (!range || field === 'muscleOrTailLength') continue;
    if (typeof range.min === 'number' && (c[field] < range.min || c[field] > range.max)) notes.push(`${range.label ?? field} ${c[field]} 超出可選範圍。`);
  }
  for (const [field, color] of Object.entries(data.colors)) {
    if (color && !colourIds(field, color.count).includes(c[field])) notes.push(`${color.label} ${c[field]} 不在此角色的色票中。`);
  }
  return notes;
}
