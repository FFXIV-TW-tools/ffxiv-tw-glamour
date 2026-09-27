// 換裝欄位、模型範本與角色骨架共用的對應資料。
export const SLOT_CODE = { Head: 'met', Top: 'top', Arms: 'glv', Legs: 'dwn', Feet: 'sho', Ear: 'ear', Neck: 'nek', Wrist: 'wrs', RFinger: 'rir', LFinger: 'ril' };
export const EST_KIND = { Head: 'met', Top: 'top', Hair: 'hair', Face: 'face' }; // 有額外骨架的欄
export const HUMAN_SLOTS = ['Hair', 'Face', 'Tail', 'Zear']; // 載入外貌時重建的部位（Zear＝維艾拉耳朵，角色描述 slot 12）
export const PART_NAME = { Hair: '髮型', Face: '臉', Tail: '尾巴', Zear: '耳朵', Body13: '身體零件（13 欄）', Body14: '身體零件（14 欄）', Body15: '身體零件（15 欄）' };
export const SLOT_ORDER = [...Object.keys(SLOT_CODE), ...HUMAN_SLOTS];
export const ADDRESS = [1, 2, 3, 4]; // mtrl Wrap／Mirror／Clamp／Border → D3D11_TEXTURE_ADDRESS_*
export const IDENTITY = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
export const pad4 = (n) => String(n).padStart(4, '0');
export const pathId = (path, letter) => Number(new RegExp(`${letter}(\\d{4})_\\w+\\.mdl$`).exec(path ?? '')?.[1] ?? NaN) || null;
/** 繪圖的輸出目標（相機檔｜RT｜深度｜視埠），同 tools/equip-mode.mjs 的 passKey 前半 */
export const passTarget = (o) => `${o.vsCbs[o.rotate.camera].file}|${o.rtvs.map(v => v.res).join(',')}|${o.dsv?.res ?? ''}|${o.viewport.join(',')}`;
