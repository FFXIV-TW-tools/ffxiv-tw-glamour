// 五個背景包的公開發布：驗證後以 Cloudflare Pages 直接上傳（專案 ffxiv-tw-glamour-data，網域 glamour-data.xivtc.com 灰雲）。
// 預設僅驗證／列印，不碰網路；實際發布需明確 --deploy。
// 輸入必須是乾淨的公開包目錄：verification.json、未引用的建置檔、連結與額外資料一律拒絕。
// Pages 部署是整批原子切換（新 deployment 全部上傳完才生效），不需要 R2 時代「內容 → manifest → index」的分批順序。
// 為什麼不用 R2（2026-09-28 遷出）：R2 自訂網域一定經 zone proxy，台灣走 SJC（實測約 5 MB/s）；灰雲 Pages 走 KHH（約 15 MB/s）。
import { readFileSync, readdirSync, lstatSync, existsSync, mkdirSync, rmSync, linkSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, sep, basename, delimiter, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BUNDLES = ['indoor', 'aether', 'coast', 'forest', 'wilderness'];
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SITE = 'https://glamour.xivtc.com';
const argv = process.argv.slice(2);
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const source = arg('--from');
const project = arg('--project') ?? 'ffxiv-tw-glamour-data';
const deploy = argv.includes('--deploy');
const known = new Set(['--from', '--project', '--deploy']);
for (let i = 0; i < argv.length; i++) {
  const option = argv[i];
  if (!known.has(option)) throw new Error(`不支援的參數：${option}`);
  if (option !== '--deploy') { if (!argv[++i] || argv[i].startsWith('--')) throw new Error(`${option} 缺參數`); }
}
if (!source) throw new Error('用法：node tools/upload-bundles.mjs --from <乾淨的公開包目錄> [--project ffxiv-tw-glamour-data] [--deploy]');
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(project)) throw new Error(`Pages 專案名稱不合法：${project}`);
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
files.push('index.json');

// 快取：Pages 預設 `public, max-age=0, must-revalidate`（帶 ETag）。只有 blob/ 整個目錄都是內容雜湊檔名，才設 immutable；
// 其他目錄混有非雜湊檔名（input/s0010_0x<指標>.bin.gz、shader/bg-ps0.frag…），維持預設，更新後才不會拿到舊檔。
const stem = (file) => basename(file).replace(/\.(?:bin|gz|vert|frag|comp)$/, '').replace(/\.bin$/, '').replace(/^buf-/, '');
const unhashedBlob = files.filter((f) => f.split('/')[1] === 'blob' && !/^[A-Fa-f0-9]{12,64}$/.test(stem(f)));
if (unhashedBlob.length) throw new Error(`blob/ 下出現非雜湊檔名，不能設 immutable：${unhashedBlob.slice(0, 3).join('、')}`);
// CORS 只放行正式站；pages.dev 舊網址已由帳號層 Bulk Redirects 導到正式站，本機開發讀 ./bundles/ 不經此處。
const EXTRA = {
  _headers: `/*\n  Access-Control-Allow-Origin: ${SITE}\n  X-Content-Type-Options: nosniff\n  X-Robots-Tag: noindex\n/:bundle/blob/*\n  Cache-Control: ${IMMUTABLE}\n`,
  'robots.txt': 'User-agent: *\nDisallow: /\n',
  // 根路徑回 200，網域路由哨兵（monorepo tools/check-domain-routing.sh）才能比對池與憑證。
  'index.html': `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>角色幻化預覽背景資料</title><p>角色幻化預覽的背景資料。請前往 <a href="${SITE}/">${SITE.replace('https://', '')}</a>。</p>\n`,
  // 有 index.html 而沒有 404.html 時，Pages 對不存在的路徑回 200＋index.html（SPA 模式）⇒ 缺檔會被當成資料讀進去。
  // 放 404.html 讓缺檔明確回 404。
  '404.html': '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>找不到檔案</title><p>找不到這個背景資料檔。</p>\n',
};

for (const [key, values] of manifests) console.log(`${key}：網站 ${values.hosted} bytes／${values.files} 檔，本機遊戲資料 ${values.client} bytes`);
console.log(`Pages 專案 ${project}：${files.length} 個背景檔＋${Object.keys(EXTRA).join('、')}；${deploy ? '開始部署' : '僅驗證，不部署（加 --deploy 才發布）'}`);
if (deploy) publish();

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

/**
 * 在 repo 的 tmp/pages-stage 組出部署目錄（硬連結，不複製 400 多 MB），再以 wrangler pages deploy 整批發布。
 * ⚠️ wrangler 以**工作目錄**下的 functions/ 當 Pages Functions：從 repo 根跑會把本站的 settings 代理一起發到資料專案，
 *    所以一律在 stage 目錄內執行（2026-09-28 首次部署實際踩到）。
 */
function publish() {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const stage = join(repo, 'tmp', 'pages-stage');
  rmSync(stage, { recursive: true, force: true });
  for (const file of files) {
    const from = join(root, ...file.split('/'));
    const to = join(stage, ...file.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    try { linkSync(from, to); } catch { copyFileSync(from, to); }
  }
  for (const [name, text] of Object.entries(EXTRA)) writeFileSync(join(stage, name), text);
  const [bin, pre] = wranglerCommand();
  const run = spawnSync(bin, [...pre, 'pages', 'deploy', '.', '--project-name', project, '--branch', 'main', '--commit-dirty=true'], { cwd: stage, stdio: 'inherit', shell: false });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`wrangler pages deploy 失敗（exit ${run.status}）；線上維持前一版 deployment`);
  console.log(`完成：${files.length} 個背景檔已部署到 Pages 專案 ${project}`);
}
