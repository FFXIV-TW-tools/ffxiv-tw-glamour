# 發布檢查單（2026-09-28 初版上線）

未勾選的項目需 Owner 在 Cloudflare／Google 後台操作，或尚未實測。

## 本地可發布條件

- [x] 使用桌面 Chrome，在 1706×960 依序驗：首次使用須知、選遊戲資料夾、預設角色、載入外貌存檔；在 390×844 確認只顯示不支援提示。確認 5 種背景、換裝、染劑、轉動／縮放／上下移動、回正、重新選取資料夾及下載失敗重試均可用；檔案不經網路上傳。
  - 2026-09-28 於正式站 `glamour.xivtc.com` 以桌面 Chrome（RTX 5070 Ti、D3D11）實跑：選遊戲資料檔、室內就緒 47 秒、載入 `FFXIV_CHARA_01.dat`、依序切換乙太空間／海岸／森林／荒野全部就緒（44–85 秒，含首次下載）、換裝成功、390×844 只顯示不支援提示、主控台無錯誤。重開網頁自動還原後的換裝流程（再選資料夾後接續換上）於本機實測。
  - 未在正式站實測：下載失敗重試、染劑、轉動／縮放按鈕（開發期已驗）。
- [x] 執行 `sh deploy-prepare.sh`；只以 `_site` 作 Pages 輸出。核對檔案清單沒有 `docs/`、`tools/`、`AGENTS.md`、遊戲背景檔案。原始碼新檔不超過 500 行，設計 lint 及本工具實際操作通過。
- [x] 本 repo 的 `core.hooksPath` 指向 `C:/FFXIVProject/tools/git-hooks`；monorepo `tools/ds-manifest.json` 已登記 `ffxiv-tw-glamour → glamour-`，portal `_DESIGN-SYSTEM.md` §命名前綴已加列。

## GitHub、Cloudflare 與背景資產

- [x] 公開 repo `FFXIV-TW-tools/ffxiv-tw-glamour`，一律以 `bash ~/.claude/skills/process/tools/safe-push.sh --repo C:/FFXIVProject/external/ffxiv-tw-glamour --reason "<原因>"` 推送（canonicalTest 由 repo 根 `devloop.json` 宣告）。
- [x] 背景資料 Pages 專案 `ffxiv-tw-glamour-data`（直接上傳、不接 git）：`node tools/upload-bundles.mjs --from tmp/bundles --deploy`。`_headers` 只放行 `https://glamour.xivtc.com` 的 CORS、`/:bundle/blob/*` 設 immutable、其餘沿用 Pages 預設 `max-age=0, must-revalidate`；附 `robots.txt`（全擋）、`index.html`、`404.html`。
  - 2026-09-28 於 `ffxiv-tw-glamour-data.pages.dev` 驗：4,904 檔全部 200 且大小相符、`.gz` 以 `application/gzip` 原位元組提供且帶 br／gzip 請求也無 `Content-Encoding`、CORS 正確、缺檔回 404。20 MB 檔下載 KHH 19–26 MB/s（原 R2 經 SJC 5–7 MB/s）。
  - 初版曾用 R2 bucket `ffxiv-tw-glamour-data`（橘雲、SJC）；bucket 保留作退路，預定 2026-10-05 刪除（BACKLOG B-010）。
- [x] 網域切換（2026-09-28）：Owner 移除 R2 自訂網域、新增灰雲 CNAME `glamour-data` → `ffxiv-tw-glamour-data.pages.dev`；Pages 專案網域驗證通過。驗：4,904 檔經 `glamour-data.xivtc.com` 全部 200、大小相符、無 `Content-Encoding`、CORS 正確、全數 KHH；網域路由哨兵 16/16 ✓（已加 `glamour-data`）；正式站室內背景下載 8.6 秒（R2 時 39 秒）、海岸 10 秒（R2 時 51 秒），主控台 0 錯誤。
- [x] Cloudflare Pages 專案接 GitHub repo：build command `sh deploy-prepare.sh`；build output directory `_site`；root directory 留空。Functions → Bindings 已設 `SETTINGS_API` → `ffxiv-tw-tools-settings-api`（`/settings-api/health` 200）。線上 CSP、HSTS、`X-Frame-Options`、`nosniff`、`Referrer-Policy`、`Permissions-Policy` 皆在。
- [x] Pages custom domain `glamour.xivtc.com`，DNS CNAME 灰雲（DNS-only）；`tools/check-domain-routing.sh` 的 `PAIRS` 已加，哨兵為 ✓（172.66 池、憑證有效、內容一致）。
- [x] 舊網址轉址：`ffxiv-tw-glamour.pages.dev` 經帳號層 Bulk Redirects 301 到 `https://glamour.xivtc.com/`（2026-09-28 實測）。
- [x] 線上 `robots.txt`（AI 爬蟲封鎖清單與 portal 一致）、`sitemap.xml`、`favicon.svg`／`favicon-192.png`／`favicon.ico`（與 portal 同一份）；`/AGENTS.md`、`/docs/release-checklist.md`、`/tools/upload-bundles.mjs` 只會回首頁，拿不到原檔；`check-deploy-surface.sh` 為部署面乾淨。
- [x] Google Search Console 已提交 `https://glamour.xivtc.com/sitemap.xml`（Owner 2026-09-28）。

## Portal 串接

- [x] Portal `tools.json`：`角色幻化預覽`、`👗`、`tw-glamour`、`https://glamour.xivtc.com/`、`daily`、`beta`、`gamefile: true`，不標 `mobile`；說明「讀取本機遊戲資料，預覽全服裝幻化。」
- [x] Portal `header.js` 的 `FALLBACK_TOOLS`、`functions/_middleware.js` 的 `ALLOWED`（貓小胖圖資）、worker Origin 白名單（已部署）、設定 SDK 同源代理清單、`_DESIGN-SYSTEM.md` 前綴列；portal 測試 134/134、worker 測試 73/73。
- [x] 公告：portal `announcements.json` 已加「新工具：角色幻化預覽（BETA）」。
- [x] monorepo `docs/runbooks/sentinels.md`、`tools/check-domain-routing.sh` 的 `PAIRS`、`tools/check-deploy-surface.sh` 的 `SITES` 已登記；`check-headers-baseline.js`、`check-robots-consistency.js`、`check-favicon.js` 由 `tools.json` 反推，本站皆通過；`tools/git-hooks/README.md` 涵蓋清單已含本 repo。
- [ ] Edge 與其他顯示卡實機測試（BACKLOG B-007）；未測完前頁面維持保守相容性說明。
