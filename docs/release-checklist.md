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
- [x] R2 bucket `ffxiv-tw-glamour-data`：CORS 只允許 `https://glamour.xivtc.com` 與 `https://ffxiv-tw-glamour.pages.dev` 的 GET／HEAD（`tools/r2-cors.json`）；自訂網域 `glamour-data.xivtc.com`。R2 自訂網域一定經 Cloudflare 代理，不適用 Pages 的灰雲規則。
- [x] 背景上傳：`node tools/upload-bundles.mjs --from tmp/bundles --upload --jobs 6`（內容檔 → 各背景 manifest → index.json）。上線時全部 4,904 個網址回 200 且大小相符；二進位檔即使要求壓縮也不會帶 `content-encoding`。
  - 已知：416 個沒帶雜湊檔名的 `.bin.gz` 被網域層的瀏覽器快取設定蓋成 `max-age=14400`（見 BACKLOG B-008）。
- [x] Cloudflare Pages 專案接 GitHub repo：build command `sh deploy-prepare.sh`；build output directory `_site`；root directory 留空。Functions → Bindings 已設 `SETTINGS_API` → `ffxiv-tw-tools-settings-api`（`/settings-api/health` 200）。線上 CSP、HSTS、`X-Frame-Options`、`nosniff`、`Referrer-Policy`、`Permissions-Policy` 皆在。
- [x] Pages custom domain `glamour.xivtc.com`，DNS CNAME 灰雲（DNS-only）；`tools/check-domain-routing.sh` 的 `PAIRS` 已加，哨兵為 ✓（172.66 池、憑證有效、內容一致）。
- [ ] 舊網址轉址：`ffxiv-tw-glamour.pages.dev` 目前直接回 200，其他站的 pages.dev 都經帳號層 Bulk Redirects 301 到正式網域。**Owner**：在 Cloudflare 帳號層 Bulk Redirects 清單加一列 `ffxiv-tw-glamour.pages.dev` → `https://glamour.xivtc.com`。
- [x] 線上 `robots.txt`（AI 爬蟲封鎖清單與 portal 一致）、`sitemap.xml`、`favicon.svg`／`favicon-192.png`／`favicon.ico`（與 portal 同一份）；`/AGENTS.md`、`/docs/release-checklist.md`、`/tools/upload-bundles.mjs` 只會回首頁，拿不到原檔；`check-deploy-surface.sh` 為部署面乾淨。
- [ ] **Owner**：Google Search Console 提交 `https://glamour.xivtc.com/sitemap.xml` 並要求建立索引。

## Portal 串接

- [x] Portal `tools.json`：`角色幻化預覽`、`👗`、`tw-glamour`、`https://glamour.xivtc.com/`、`daily`、`beta`、`gamefile: true`，不標 `mobile`；說明「讀取本機遊戲資料，預覽全服裝幻化。」
- [x] Portal `header.js` 的 `FALLBACK_TOOLS`、`functions/_middleware.js` 的 `ALLOWED`（貓小胖圖資）、worker Origin 白名單（已部署）、設定 SDK 同源代理清單、`_DESIGN-SYSTEM.md` 前綴列；portal 測試 134/134、worker 測試 73/73。
- [x] 公告：portal `announcements.json` 已加「新工具：角色幻化預覽（BETA）」。
- [x] monorepo `docs/runbooks/sentinels.md`、`tools/check-domain-routing.sh` 的 `PAIRS`、`tools/check-deploy-surface.sh` 的 `SITES` 已登記；`check-headers-baseline.js`、`check-robots-consistency.js`、`check-favicon.js` 由 `tools.json` 反推，本站皆通過；`tools/git-hooks/README.md` 涵蓋清單已含本 repo。
- [ ] Edge 與其他顯示卡實機測試（BACKLOG B-007）；未測完前頁面維持保守相容性說明。
