// 從玩家選的遊戲資料夾（<input type="file" webkitdirectory>）或多選的檔案裡挑出需要的 sqpack 檔。
// 不用 showDirectoryPicker：Chrome 的 File System Access 封鎖 C:\Program Files 整棵（連檔案都擋，
// chromium chrome_file_system_access_permission_context.cc 的 DIR_PROGRAM_FILES＝kBlockAllChildren），
// 台服官方預設安裝路徑 C:\Program Files\USERJOY GAMES\FINAL FANTASY XIV TC 就在裡面（2026-09-27 Owner 另一台實際被擋）。
// 傳統 <input type="file"> 不套這份清單；選資料夾時 Chrome 會跳「要將 N 個檔案上傳到這個網站嗎？」（預設按鈕是取消，
// 見 file_select_helper.cc CreateConfirmationDialog），檔案仍只在瀏覽器裡讀。

/**
 * @param {FileList|File[]} fileList 選到的檔案（資料夾模式帶 webkitRelativePath）
 * @param {RegExp} re 要的檔名（例如 /^(040000|050000)\.win32\.(index|dat(\d+))$/）
 * @returns {File[]} 符合 re 的檔；選到的資料夾裡有不只一份遊戲資料時丟錯（index 與 dat 混用會讀錯）
 */
export function pickSqpackFiles(fileList, re) {
  const hits = [...fileList].filter((f) => re.test(f.name));
  const dirs = new Set(hits.map((f) => (f.webkitRelativePath || f.name).split('/').slice(0, -1).join('\\')));
  if (dirs.size > 1) throw new Error(`選到的資料夾裡有不只一份遊戲資料（${[...dirs].join('、')}），請改選其中一份的安裝資料夾`);
  return hits;
}
