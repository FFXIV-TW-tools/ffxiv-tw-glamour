import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const generator = fileURLToPath(new URL('../../ffxiv-tw-tools-portal/tools/gen-site-icons.mjs', import.meta.url));
const config = fileURLToPath(new URL('./icons.config.json', import.meta.url));

test('glamour icons match portal canonical paths', (t) => {
  if (!existsSync(generator)) return t.skip('沒有 portal 圖示產生器；CI 可獨立 checkout');
  const result = spawnSync(process.execPath, [generator, '--config', config, '--check'], { encoding: 'utf8' });
  if (result.status === 2) return t.skip(`沒有 portal 圖示正典：${result.stderr.trim()}`);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
