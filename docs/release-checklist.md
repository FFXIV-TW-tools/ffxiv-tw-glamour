# 發布檢查單（Owner 手動執行；目前未部署）

## 本地可發布條件

- [ ] 使用桌面 Chrome，在 1706×960 依序驗：首次使用須知、選遊戲資料夾、預設角色、載入外貌存檔；在 390×844 確認只顯示不支援提示。確認 5 種背景、換裝、染劑、轉動／縮放／上下移動、回正、重新選取資料夾及下載失敗重試均可用；檔案不經網路上傳。
- [ ] 執行 `sh deploy-prepare.sh`；只以 `_site` 作 Pages 輸出。核對檔案清單沒有 `docs/`、`tools/`、`AGENTS.md`、遊戲背景檔案。原始碼新檔不超過 500 行，設計 lint 及本工具實際操作通過。
- [ ] 設定本 repo 的 `core.hooksPath` 指向本機 `FFXIVProject/tools/git-hooks`；確認 `tools/ds-manifest.json` 的 `ffxiv-tw-glamour → glamour-` 已登記，並**在 portal `_DESIGN-SYSTEM.md` §命名前綴同步加一列**（此階段 portal working tree 不修改）。

## GitHub、Cloudflare 與背景資產

- [ ] 初版 commit（Owner 授權；pre-commit hooks 會跑 secret／檔案大小／design-lint）。建立公開 GitHub repo 但**不要**用 `gh repo create --push`：`gh repo create FFXIV-TW-tools/ffxiv-tw-glamour --public --source . --remote origin --description "角色幻化預覽"`，再以 `bash ~/.claude/skills/process/tools/safe-push.sh --repo C:/FFXIVProject/external/ffxiv-tw-glamour --reason "初版發布"` 推送（canonicalTest 由 repo 根 `devloop.json` 宣告）。
- [ ] R2（wrangler 4.x，`wrangler whoami` 確認登入的是 Owner 帳號）：`wrangler r2 bucket create ffxiv-tw-glamour-data` → `wrangler r2 bucket cors set ffxiv-tw-glamour-data --file tools/r2-cors.json`（只允許 `https://glamour.xivtc.com` 與 `https://ffxiv-tw-glamour.pages.dev` 的 GET／HEAD）→ 自訂網域：Dashboard「R2 → ffxiv-tw-glamour-data → Settings → Custom Domains → Connect Domain」填 `glamour-data.xivtc.com`（或 `wrangler r2 bucket domain add ffxiv-tw-glamour-data --domain glamour-data.xivtc.com --zone-id <xivtc.com 的 Zone ID>`）。R2 自訂網域一定經 Cloudflare 代理，不適用 Pages 的灰雲規則。
- [ ] 上傳背景：`node tools/upload-bundles.mjs --from tmp/bundles` 先看 dry-run，再 `node tools/upload-bundles.mjs --from tmp/bundles --upload --jobs 6`。分三批：內容檔 → 各背景 manifest → index.json；任一檔重試兩次仍失敗就停止且不更新 index.json。驗證：`curl -sI -H "Origin: https://glamour.xivtc.com" https://glamour-data.xivtc.com/index.json` 應有 `access-control-allow-origin` 與 `cache-control: public, max-age=0, must-revalidate`；抽一個 `indoor/blob/<雜湊>.bin.gz` 應為 `immutable` 且**沒有** `content-encoding`。
- [ ] Cloudflare Pages 專案接 GitHub repo：build command **`sh deploy-prepare.sh`**；build output directory **`_site`**；root directory 留空。部署後確認 CSP 允許 portal、XIVAPI 圖示與 R2 背景；本地 HTTP server 不套 `_headers`，無法替代線上檢查。
- [ ] Pages custom domain 掛 **`glamour.xivtc.com`**；DNS CNAME 切為**灰雲（DNS-only）**，依 `_NEW-TOOL.md` §3b 核對新子網域安全決策表：全站腳本自控、無使用者生成 HTML、無 `unsafe-eval`／第三方腳本。將網域加入 `tools/check-domain-routing.sh` 的 `PAIRS` 再跑哨兵；檢查 Pages 域名舊網址的邊緣轉址。
- [ ] 驗線上 `robots.txt`、`sitemap.xml`、favicon、GSC 中的網址前置字元資源及 sitemap；向 Google Search Console 提交 `https://glamour.xivtc.com/sitemap.xml` 並要求建立索引。`/AGENTS.md`、`/docs/release-checklist.md`、`/tools/upload-bundles.mjs` 不得能下載到檔案。

## Portal 串接（只在上線時動 portal，這次不改）

- [ ] Portal `tools.json` 加入 `ffxiv-tw-glamour`：`name: 角色幻化預覽`、`icon: 👗`、`slug: tw-glamour`、`url: https://glamour.xivtc.com/`、`category: daily`、`status: beta`，不標示 `mobile: true`；視需求勾 `gamefile: true`，描述寫一整句繁體中文。
- [ ] 同時更新 portal `header.js` 的 `FALLBACK_TOOLS` 和 `functions/_middleware.js` 的 `ALLOWED`（貓小胖資產白名單），以及 portal `_DESIGN-SYSTEM.md` 的 `glamour-` 命名前綴列。跑 portal 的既有測試後再部署 portal，勿只改 `tools.json`。
- [ ] 在 monorepo `docs/runbooks/sentinels.md` 登記新站及適用的部署面探針；將新站加入 `tools/check-domain-routing.sh` 的 `PAIRS`，並檢查 `tools/check-deploy-surface.sh`、`tools/check-headers-baseline.js`、`tools/check-robots-consistency.js`、`tools/check-favicon.js` 等各自的涵蓋率或站清單。核對 `tools/git-hooks/README.md` 涵蓋清單已包含此 repo。
- [ ] 上線後實跑線上瀏覽器驗 CSP、背景快取與 CORS，確認 WebGL2 硬體加速可用；如 Edge/其他顯卡仍未實測，頁面維持保守相容性說明，不擴大宣稱。
