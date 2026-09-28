// 開發站的 /bundles/ 對應私有 spike 產物；公開站只讀背景資料 Pages 專案（ffxiv-tw-glamour-data）上的衍生背景資料。
const local = /^(localhost|127\.0\.0\.1)$/.test(globalThis.location?.hostname ?? '')
  || (globalThis.location?.hostname ?? '').endsWith('.ts.net');
export const BUNDLE_BASE = local ? './bundles/' : 'https://glamour-data.xivtc.com/';
