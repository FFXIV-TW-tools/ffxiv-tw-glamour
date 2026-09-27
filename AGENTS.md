# 角色幻化預覽 — 維護鐵則

- 公開網址：<https://glamour.xivtc.com/>。本站是靜態 Cloudflare Pages 工具，使用者親自選取台服遊戲資料夾；檔案只在瀏覽器讀取，**不得上傳遊戲檔案或外貌存檔**。五種背景由獨立 R2 網域提供，不能將背景資料放入 Pages 或 git repo。
- 對外 HTML/CSS 先讀 portal `_DESIGN-SYSTEM.md`，並從 `templates/new-tool.html` 起手。共享元件用 `.codex-*`；新私有 class 一律 `glamour-`，顏色走 portal token；不得另自刻按鈕、modal 或一套命名系統。使用者文案寫完整繁體中文，以 `docs/reference/ui-terms.json` 核對台服用語。頁面不得提資料取得的內部作業方式。
- 使用者的本機遊戲檔案讀取與瀏覽器保存邊界分別在 `js/game/client-packs.js`、`js/game/client-cache.js`；需求清單以 `REQUIRED_PACKS` 為唯一事實源。`js/app/guide.js` 只維護步驟及操作說明，讀取/渲染由 `js/app/game-app.js` 負責。修改 DOM id 或 `LookPanel`／`SlotPanel` API 時須同步兩端，背景切換必保留外貌、裝備及染劑。
- 新增手寫原始碼檔案不得超過 500 行，按責任拆檔；不要把所有背景或所有裝備預先載入。初次進站先由玩家選遊戲資料夾，之後才下載第一個背景；回訪可還原已保存的資料。
- **瀏覽器保存邊界（2026-09-27）**：只保存玩家實際讀過的遊戲檔案內容與使用過的查詢結果，以 `game/ffxivgame.ver` 遊戲版本隔離；版本改變就清除，絕不將遊戲檔案、外貌或保存的內容上傳。
- **裝備缺範本不得整件丟棄（2026-09-27）**：同一件裝備若有網格的材質缺少可重播範本，只略過該網格並明列警告，其餘已驗證的網格照常繪製；全件都沒有可重播的繪圖時才拒絕該件。案例：c1801 e0581 上衣首網格 `charactertransparency` 無範本，原本連同其餘已驗證的上衣／皮膚網格整件消失，造成頭身分離（修在 `js/engine/equip-draws.js`）。
- **Hi-Z 不得省略，改寫成直接 shader（2026-09-27）**：翻譯的 compute 若用 group 模擬做的只是各像素獨立的最大／最小值縮減，先確認完整 mip 逐值相同，再特化成直接的 fragment shader；不可為了效能省掉 SSR 必需的 Hi-Z。案例：原 group 模擬每像素迭代 64 條執行緒並散佈 4 次，耗時 6–9 ms；改成直接輸出 4 層的 shader 後，室內／森林 mip0–3 逐值相同，耗時 0.09 ms（`js/engine/hierarchical-depth.js`）。
- **回訪模式擋操作要在原處說明並接續（2026-09-28）**：自動還原後只有保存過的遊戲資料，瀏覽器也不能自行重讀本機資料夾，換裝／調整外貌需要再選一次資料夾。提示一律開 `#folder-prompt` 視窗，並把被擋的操作交給 `needFolder(resume, 說明)`，同版本資料夾讀好後接續；取消（視窗或檔案選擇）即清除。不可用 `focus()` 跳到側欄頂的資料夾按鈕代替提示。案例：舊做法按「更換」只把側欄捲到最上方，清單也不開，玩家以為卡住。不需遊戲檔案的操作（例如瀏覽裝備清單）不要擋。

## 發布邊界

- Cloudflare Pages build command **`sh deploy-prepare.sh`**，output directory **`_site`**。`deploy-allow.txt` 是唯一可發布根層項目；`deploy-deny.txt` 明列內部項目；未分類項目使 build 失敗。**不得**改為直接以 repo root 部署。每次調整發布面先跑 `sh deploy-prepare.sh` 並確認 `_site` 只有站台資產；絕不把 `docs/`、`tools/`、`AGENTS.md` 或遊戲背景發到 Pages。
- 背景資料只由 `tools/upload-bundles.mjs` 上傳到 R2；公開位址 `https://glamour-data.xivtc.com/`。變更背景後確認 R2 上的背景索引 index.json 對應新版本與上傳輸出，再部署頁面；不要在此 repo 加入數百 MB 的背景資料。R2 CORS 必允許站台網域的 GET（設定檔 `tools/r2-cors.json`）。
- 新資料來源：從 repo 根執行 `python tools/data/build-items.py` 產生分部位裝備資料與預設服裝小檔 `data/items/preset.json`；`dotnet run --project tools/data/charamake-export -c Release -- export` 產生角色選項、職業及 UI 用語；`python tools/data/verify-charamake.py` 核對角色選項。`charamake-export/Program.cs` 的 SqPack 路徑目前指向本機安裝位置，換機前須核對該常數。資料更新時對照台服遊戲資料版本，勿手改生成 JSON。
- 提交前跑 `node C:/FFXIVProject/tools/check-design-drift.js --files index.html css/app.css css/panels.css --strict`（repo 根的 `devloop.json` canonicalTest 用相對路徑執行同一支）和對應變更的實際操作；部署後驗 CSP、資料路由、`robots.txt` 與檔案未外洩。repo 使用 monorepo `tools/git-hooks` 的共用 hooks，跨機需按本機根目錄重設 `core.hooksPath`。
