# 更新紀錄

## 2026-09-28 — 背景資料改由 Pages 提供

- 背景資料由 R2 遷到獨立的 Pages 專案 `ffxiv-tw-glamour-data`（網域 `glamour-data.xivtc.com` 改為灰雲），網址不變。台灣連線由 SJC 改走 KHH：正式站室內背景下載 39 → 8.6 秒、海岸 51 → 10 秒。
- `tools/upload-bundles.mjs` 改為 Pages 直接上傳（`--deploy`，整批原子切換）；`_headers` 只放行正式站 CORS、blob 長快取，附 robots／index／404；刪除 `tools/r2-cors.json`。R2 bucket 保留作退路至 2026-10-05（BACKLOG B-010）。
- `robots.txt` 的 AI 爬蟲封鎖清單隨 portal 擴充為 175 個 UA。

## 2026-09-28 — 初版上線（https://glamour.xivtc.com/）

- 建立角色幻化預覽公開頁面：選取本機台服遊戲資料、可略過的外貌存檔載入、裝備與染劑調整、5 種背景切換與操作引導。
- 各背景首次使用時才下載，顯示即時流量與進度，並在瀏覽器內快取。
- 回訪時自動還原上次預覽的背景、角色外貌、裝備、染劑與取景；只在瀏覽器保存實際使用的遊戲資料，換版本或手動清除後重新選資料夾。
- 新增使用須知、桌面裝置要求、發布允許清單與安全標頭；整理待辦及發布驗收清單。
- 預覽畫面下方的背景、轉動與縮放控制可收起，只留一顆按鈕，需要時再展開。
- 修正視窗較矮時預覽畫面被橫向拉寬：畫面一律維持 16:9，改以縮小寬度配合可用高度。
- 修正重開網頁、自動還原上次預覽後，按裝備「更換」會把側欄捲到最上方而無法選裝：現在可直接瀏覽裝備清單；選好裝備時在原處說明需要再選一次遊戲資料夾，選好後自動換上剛才選的裝備，取消則不套用。
- 設定同步改走本站同源的 `/settings-api/` 代理（Pages Functions＋service binding）。
- 頁面明示「必須在已安裝台服遊戲主程式的電腦上使用」：預覽區初始畫面、右側「開始預覽」、使用須知最上方與手機提示都會顯示。
- 「必須安裝遊戲主程式」提示改用 portal 共用的 `codex-tint-panel`（左緣色條＋警示色），刪除本站自刻的樣式。
- `robots.txt` 的 AI 爬蟲封鎖清單補上 `Claude-User`、`Claude-SearchBot`，與 portal 一致；`favicon-192.png` 換回 portal 同一份、補 `favicon.ico` 並列入發布允許清單（哨兵 `check-robots-consistency`／`check-favicon` 抓到）。
- 上線驗收紀錄與剩餘的 Owner 後台動作見 `docs/release-checklist.md`；上線後已知待辦記在 `docs/BACKLOG.md`（B-008、B-009）。
