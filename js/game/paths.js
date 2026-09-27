// 由外貌與裝備推算遊戲會載入的檔案與子網格顯示規則（不依賴 three.js，網頁與 Node 校準工具共用）。
// 每條規則都要能以插件匯出的 glamour.json 對照（tools/verify-derivation.mjs）。
import { fallbackChain } from './customize.js';

export const ARMOR = ['met', 'top', 'glv', 'dwn', 'sho'];
export const ACCESSORY = ['ear', 'nek', 'wrs', 'rir', 'ril'];
export const SLOTS = [...ARMOR, ...ACCESSORY];
const IMC_PART = { met: 0, top: 1, glv: 2, dwn: 3, sho: 4, ear: 0, nek: 1, wrs: 2, rir: 3, ril: 4 };
export const pad4 = (n) => String(n).padStart(4, '0');
const isAccessory = (slot) => ACCESSORY.includes(slot);

export function gearModelPath(set, slot, code) {
  return isAccessory(slot)
    ? `chara/accessory/a${pad4(set)}/model/c${pad4(code)}a${pad4(set)}_${slot}.mdl`
    : `chara/equipment/e${pad4(set)}/model/c${pad4(code)}e${pad4(set)}_${slot}.mdl`;
}

export const imcPath = (set, slot) => (isAccessory(slot) ? `chara/accessory/a${pad4(set)}/a${pad4(set)}.imc` : `chara/equipment/e${pad4(set)}/e${pad4(set)}.imc`);

/** IMC 檔 → (variant) → 該部位 { materialId, attributeMask } */
export function imcEntry(bytes, variant, slot) {
  if (!bytes) return { materialId: 1, attributeMask: 0x3ff };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint16(0, true);
  let parts = 0;
  for (let m = dv.getUint16(2, true); m; m &= m - 1) parts++;
  const v = variant <= count ? variant : 0;
  const o = 4 + (v * parts + IMC_PART[slot]) * 6;
  if (o + 6 > bytes.length) return { materialId: 1, attributeMask: 0x3ff };
  return { materialId: dv.getUint8(o) || 1, attributeMask: dv.getUint16(o + 2, true) & 0x3ff };
}

/** 找得到的第一個裝備模型：角色種族 → 替代鏈（例 801→201→101）。@param has(path) → 是否存在 */
export function resolveGear(has, set, slot, code) {
  for (const c of fallbackChain(code)) {
    const path = gearModelPath(set, slot, c);
    if (has(path)) return { path, code: c };
  }
  return null;
}

/** mdl 內的材質名 → 候選路徑（依序試讀）。@param code 角色種族碼 */
export function materialPaths(name, materialId, code) {
  const n = name.replace(/^\//, '');
  let m;
  if ((m = /^mt_c\d{4}b\d{4}(_.+)$/.exec(n))) {
    // 裝備裡的身體皮膚一律換成角色自己種族的皮膚，沒有就沿替代鏈（貓魅族女性→c0201：2026-09-25 與遊戲匯出一致）
    return fallbackChain(code).map((c) => `chara/human/c${pad4(c)}/obj/body/b0001/material/v0001/mt_c${pad4(c)}b0001${m[1]}`);
  }
  // 臉與維艾拉耳朵的材質不分版本資料夾；頭髮、尾巴放在 v0001（2026-09-25 以索引實查）
  if ((m = /^mt_c(\d{4})([fz])(\d{4})_/.exec(n))) return [`chara/human/c${m[1]}/obj/${m[2] === 'f' ? 'face' : 'zear'}/${m[2]}${m[3]}/material/${n}`];
  if ((m = /^mt_c(\d{4})([ht])(\d{4})_/.exec(n))) {
    return [`chara/human/c${m[1]}/obj/${m[2] === 'h' ? 'hair' : 'tail'}/${m[2]}${m[3]}/material/v0001/${n}`];
  }
  if ((m = /^mt_c\d{4}([ea])(\d{4})_/.exec(n))) {
    const root = m[1] === 'e' ? `chara/equipment/e${m[2]}` : `chara/accessory/a${m[2]}`;
    return [`${root}/material/v${pad4(materialId)}/${n}`, `${root}/material/v0001/${n}`];
  }
  return [];
}

// 部位變體屬性 atr_{mv,tv,gv,dv,sv,…}_{a..j} 由 IMC 屬性遮罩第 0..9 位決定（命名對照 Penumbra KnownAttribute）。
const VARIANT_ATTR = /^atr_(?:mv|tv|gv|dv|sv|ev|nv|wv|rv|bv|hv|parts)_([a-j])$/;

/** @param features 外貌參數臉部特徵位元（byte12 第 0..6 位，對應 atr_fv_a..g） */
export function attributeVisible(name, imcMask, tail, features) {
  const m = VARIANT_ATTR.exec(name);
  if (m) return !!(imcMask & (1 << (m[1].charCodeAt(0) - 97)));
  const fv = /^atr_fv_([a-g])$/.exec(name);
  if (fv) return !!(features & (1 << (fv[1].charCodeAt(0) - 97)));
  if (name === 'atr_tls') return tail; // 有尾種族才顯示
  if (name === 'atr_tlh') return !tail; // 無尾種族才顯示
  return true; // 其餘由他部位 EQP 控制（護頸、手肘、膝…）：尚未推算，一律顯示
}
