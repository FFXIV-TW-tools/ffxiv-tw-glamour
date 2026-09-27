// 推送前檢查（devloop.json canonicalTest）：git 追蹤的所有 .js／.mjs 語法正確（node --check），
// 且手寫原始碼每檔不超過 500 行（與 monorepo pre-commit 的新檔大小閘同一門檻）。任一不符即 exit 1。
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LIMIT = 500;
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const failures = [];
for (const file of files) {
  if (/\.(js|mjs)$/.test(file)) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) failures.push(`語法錯誤 ${file}：${(r.stderr || '').trim().split('\n').slice(0, 3).join(' ')}`);
  }
  if (/\.(js|mjs|cjs|html|css|py|cs)$/.test(file)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    if (lines > LIMIT) failures.push(`超過 ${LIMIT} 行 ${file}：${lines} 行`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`原始碼檢查通過：${files.length} 個追蹤檔`);
