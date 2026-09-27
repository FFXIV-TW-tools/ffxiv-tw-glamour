// 預設服裝小檔於選好遊戲資料夾時讀取；完整部位清單只在展開時讀取，左右戒指共用 rir.json。
const slotCache = new Map();
let metadata, presets;

export const slotCode = { Head: 'met', Top: 'top', Arms: 'glv', Legs: 'dwn', Feet: 'sho', Ear: 'ear', Neck: 'nek', Wrist: 'wrs', RFinger: 'rir', LFinger: 'rir' };
const decodeRows = (fields, rows) => rows.map((row) => Object.fromEntries(fields.map((field, index) => [field, row[index]])));

/** 只讀所有種族預設服裝的小檔；不下載任何部位的完整清單。 */
export function presetItems() {
  presets ??= fetch('./data/items/preset.json').then((r) => {
    if (!r.ok) throw new Error(`讀不到預設服裝資料（${r.status}）`);
    return r.json();
  }).then(({ fields, slots, jobs, restrictions, raceNames }) => ({
    byCode: Object.fromEntries(Object.entries(slots).map(([code, rows]) => [code, decodeRows(fields, rows)])),
    metadata: { jobs, restrictions, raceNames },
  })).catch((error) => { presets = null; throw error; });
  return presets;
}

export function slotItems(slot) {
  const code = slotCode[slot];
  if (!slotCache.has(code)) slotCache.set(code, fetch(`./data/items/${code}.json`).then((r) => {
    if (!r.ok) throw new Error(`讀不到${code}部位的物品資料（${r.status}）`);
    return r.json();
  }).then(({ fields, rows }) => decodeRows(fields, rows))
    .catch((error) => { slotCache.delete(code); throw error; }));
  return slotCache.get(code);
}

export function slotMetadata() {
  metadata ??= Promise.all([
    fetch('./data/job-categories.json').then((r) => { if (!r.ok) throw new Error('讀不到職業類別'); return r.json(); }),
    fetch('./data/equip-restriction.json').then((r) => { if (!r.ok) throw new Error('讀不到裝備限制'); return r.json(); }),
    fetch('./data/races.json').then((r) => { if (!r.ok) throw new Error('讀不到種族名稱'); return r.json(); }),
  ]).then(([jobs, restrictions, races]) => ({ jobs, restrictions, raceNames: Object.fromEntries(races.races.map(([id, name]) => [id, name])) }))
    .catch((error) => { metadata = null; throw error; });
  return metadata;
}

export function iconUrl(icon) {
  if (!icon) return null;
  const id = String(icon);
  const folder = String(Math.floor(+id / 1000) * 1000).padStart(6, '0');
  return `https://v2.xivapi.com/api/asset/ui/icon/${folder}/${id.padStart(6, '0')}_hr1.tex?format=png`;
}

export function marketboardUrl(id) {
  const base = ['localhost', '127.0.0.1'].includes(location.hostname)
    ? 'http://localhost:8774/ffxiv-tw-marketboard/' : 'https://market.xivtc.com/';
  return `${base}#/item/${id}`;
}

export function inGameRestriction(item, character, metadata) {
  const value = metadata?.restrictions?.values?.[item.restriction];
  if (!value || !character) return { allowed: null, label: '裝備限制未明' };
  const allowed = value.raceIds.includes(character.race) && value.genders.includes(character.gender);
  if (allowed) return { allowed, label: '此角色可穿戴' };
  const race = value.raceIds.length === 8 ? '所有種族' : `限定${value.raceIds.map((id) => metadata.raceNames[id] ?? `種族 ${id}`).join('、')}`;
  const gender = value.genders.length === 2 ? '所有性別' : value.genders[0] ? '女性' : '男性';
  return { allowed, label: `遊戲內不可穿戴（${race}、${gender}）；仍可嘗試預覽` };
}
