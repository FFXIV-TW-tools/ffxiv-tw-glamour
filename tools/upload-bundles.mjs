// 五個背景包的公開 R2 上傳計畫；預設僅驗證／列印，不碰網路。實際上傳需明確 --upload。
// 輸入必須是乾淨的公開包目錄：verification.json、未引用的建置檔、連結與額外資料一律拒絕。
// 上傳分三批依序進行：內容檔 → 各背景 manifest.json → index.json；前一批全部成功才開始下一批，
// 任一檔重試後仍失敗就停止，不更新 index.json（線上維持前一版）。每批內以 --jobs 個 wrangler 並行。
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join, relative, sep, basename, delimiter, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BUNDLES = ['indoor', 'aether', 'coast', 'forest', 'wilderness'];
const REVALIDATE = 'public, max-age=0, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const argv = process.argv.slice(2);
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const source = arg('--from');
const bucket = arg('--bucket') ?? 'ffxiv-tw-glamour-data';
const upload = argv.includes('--upload');
const jobs = Number(arg('--jobs') ?? 6);
const known = new Set(['--from', '--bucket', '--upload', '--jobs']);
for (let i = 0; i < argv.length; i++) {
  const option = argv[i];
  if (!known.has(option)) throw new Error(`不支援的參數：${option}`);
  if (option !== '--upload') { if (!argv[++i] || argv[i].startsWith('--')) throw new Error(`${option} 缺參數`); }
}
if (!source) throw new Error('用法：node tools/upload-bundles.mjs --from <乾淨的公開包目錄> [--bucket ffxiv-tw-glamour-data] [--jobs 6] [--upload]');
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) throw new Error(`--jobs 須為 1–16：${arg('--jobs')}`);
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error(`R2 bucket 名稱不合法：${bucket}`);
const root = resolve(source);
const allowed = new Map();
const allowedDirs = new Set(['']);
const expected = (key, file, bytes) => {
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(file) || file.split('/').includes('..')) throw new Error(`不安全的包路徑：${file}`);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`${key}/${file} 的位元組數無效`);
  const name = key ? `${key}/${file}` : file;
  if (allowed.has(name)) throw new Error(`清單重複檔案：${name}`);
  allowed.set(name, bytes);
  for (let slash = name.indexOf('/'); slash >= 0; slash = name.indexOf('/', slash + 1)) allowedDirs.add(name.slice(0, slash));
};
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const index = json('index.json');
if (Object.keys(index).sort().join() !== [...BUNDLES].sort().join()) throw new Error('index.json 必須恰好列出五個背景');
const manifests = new Map();
for (const key of BUNDLES) {
  const manifestFile = `${key}/manifest.json`;
  const manifest = json(manifestFile);
  if (!manifest.download || !Array.isArray(manifest.download.files) || !manifest.clientFiles) throw new Error(`${key} manifest 缺少下載清單或本機資料對照`);
  const local = manifest.clientFiles;
  for (const [file, ref] of Object.entries(local)) {
    if (!/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || !ref.method || !(ref.category || ref.parts)) throw new Error(`${key} 的 client 參照不完整：${file}`);
  }
  const size = lstatSync(join(root, manifestFile)).size;
  expected(key, 'manifest.json', size);
  let total = size;
  for (const row of manifest.download.files) {
    if (!Array.isArray(row) || row.length !== 2) throw new Error(`${key} 的下載清單格式不正確`);
    const [file, bytes] = row;
    if (typeof file !== 'string' || file.startsWith('client/') || local[file]) throw new Error(`${key} 下載清單包含本機檔案：${file}`);
    expected(key, file, bytes);
    total += bytes;
  }
  if (manifest.download.total !== total - size || index[key]?.total !== total || index[key]?.files !== manifest.download.files.length + 1) throw new Error(`${key} 的下載大小／檔案數與 index.json 不一致`);
  manifests.set(key, { hosted: total, client: Object.values(local).reduce((n, ref) => n + ref.bytes, 0), files: manifest.download.files.length + 1 });
}
expected('', 'index.json', lstatSync(join(root, 'index.json')).size);
// 雙向比對：清單之外的任何檔案都拒絕；清單中的檔案逐一核對實際位元組數。
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    const stat = lstatSync(full);
    const file = relative(root, full).split(sep).join('/');
    if (stat.isDirectory()) {
      if (!allowedDirs.has(file)) throw new Error(`包目錄含清單外目錄：${file}`);
      scan(full);
      continue;
    }
    if (!stat.isFile()) throw new Error(`包目錄含連結或非檔案：${file}`);
    if (!allowed.has(file)) throw new Error(`包目錄含清單外檔案：${file}`);
    if (stat.size !== allowed.get(file)) throw new Error(`${file} 大小 ${stat.size} ≠ 清單 ${allowed.get(file)}`);
    allowed.delete(file);
  }
}
scan(root);
if (allowed.size) throw new Error(`包目錄缺清單檔案：${[...allowed.keys()].slice(0, 5).join('、')}`);

const files = [];
for (const key of BUNDLES) {
  const manifest = json(`${key}/manifest.json`);
  for (const [file] of manifest.download.files) files.push(`${key}/${file}`);
}
for (const key of BUNDLES) files.push(`${key}/manifest.json`);
files.push('index.json'); // 最後更新索引，避免先宣告尚未上傳完的新背景。
function headers(file) {
  const ext = file.match(/\.([a-z]+)$/)?.[1];
  const contentType = ext === 'json' ? 'application/json; charset=utf-8'
    : ['vert', 'frag', 'comp'].includes(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream';
  // 僅以內容雜湊為整個主檔名的檔可 immutable；input/s0010_0x<指標>.bin.gz、shader/bg-ps0.frag 不是內容雜湊。
  const stem = basename(file).replace(/\.(?:bin|gz|vert|frag|comp)$/, '').replace(/\.bin$/, '').replace(/^buf-/, '');
  const immutable = /^[A-Fa-f0-9]{12,64}$/.test(stem);
  return { contentType, cacheControl: immutable ? IMMUTABLE : REVALIDATE };
}
for (const [key, values] of manifests) console.log(`${key}：網站 ${values.hosted} bytes／${values.files} 檔，本機遊戲資料 ${values.client} bytes`);
console.log(`R2 bucket ${bucket}，共 ${files.length} 個公開檔案；${upload ? `開始遠端上傳（${jobs} 個並行）` : '僅列印 dry-run 計畫，不上傳'}`);
for (const file of files) {
  const { contentType, cacheControl } = headers(file);
  console.log(`${upload ? 'QUEUE' : 'PLAN'} ${bucket}/${file} ${contentType} ${cacheControl}`);
}
if (upload) await uploadAll();

/**
 * wrangler 執行檔：Windows 的 npm 全域安裝只有 wrangler.cmd，spawn 不經 shell 會 ENOENT（2026-09-27 本機 4.94.0 實測），
 * 所以一律用目前的 node 直接跑 wrangler 的 bin/wrangler.js。找的順序：WRANGLER_JS 環境變數、本 repo node_modules、PATH 各目錄下的 node_modules。
 */
function wranglerCommand() {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const candidates = [process.env.WRANGLER_JS, join(repo, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'node_modules', 'wrangler', 'bin', 'wrangler.js'))].filter(Boolean);
  const entry = candidates.find((p) => existsSync(p));
  if (entry) return [process.execPath, [entry]];
  if (process.platform !== 'win32') return ['wrangler', []];
  throw new Error('找不到 wrangler 的 bin/wrangler.js：請先 npm install -g wrangler（4.x），或以環境變數 WRANGLER_JS 指定路徑');
}

function putOnce(command, file) {
  const { contentType, cacheControl } = headers(file);
  const args = [...command[1], 'r2', 'object', 'put', `${bucket}/${file}`, '--file', join(root, ...file.split('/')), '--content-type', contentType, '--cache-control', cacheControl, '--remote'];
  return new Promise((done) => {
    const child = spawn(command[0], args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let err = '';
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-2000); });
    child.on('error', (e) => done(e.message));
    child.on('close', (code) => done(code === 0 ? null : `exit ${code}：${err.trim().split('\n').slice(-3).join(' ')}`));
  });
}

async function uploadAll() {
  const command = wranglerCommand();
  const manifestFiles = BUNDLES.map((key) => `${key}/manifest.json`);
  const batches = [files.filter((f) => f !== 'index.json' && !manifestFiles.includes(f)), manifestFiles, ['index.json']];
  let done = 0;
  for (const batch of batches) {
    let next = 0, failed = null;
    await Promise.all(Array.from({ length: Math.min(jobs, batch.length) }, async () => {
      while (!failed && next < batch.length) {
        const file = batch[next++];
        let error = null;
        for (let attempt = 0; attempt < 3; attempt++) { error = await putOnce(command, file); if (!error) break; }
        if (error) { failed = `${file}：${error}`; return; }
        done++;
        if (done % 100 === 0 || done === files.length) console.log(`已上傳 ${done}/${files.length}`);
      }
    }));
    if (failed) throw new Error(`R2 上傳失敗（重試 2 次），已停止、未更新 index.json：${failed}`);
  }
  console.log(`完成：${done} 個檔案已上傳到 ${bucket}`);
}
