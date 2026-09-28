import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchingEquipment, outfitText } from '../js/app/game-slots.js';
import { DownloadPanel } from '../js/app/game-download.js';

const metadata = {
  restrictions: { values: {
    1: { raceIds: [1], genders: [0] },
    2: { raceIds: [2], genders: [1] },
  } },
  raceNames: { 1: '人族', 2: '精靈族' },
};
const sorted = [
  { name: '紅色頭盔', restriction: 2 },
  { name: '紅色帽子', restriction: 99 },
  { name: '紅色面罩', restriction: 1 },
  { name: '藍色頭盔', restriction: 1 },
];

test('可穿戴篩選先依搜尋與既定排序，再排除已知不可穿戴；限制未明保留', () => {
  const character = { race: 1, gender: 0 };
  assert.deepEqual(matchingEquipment(sorted, '紅色', true, character, metadata).map((item) => item.name), ['紅色帽子', '紅色面罩']);
  assert.deepEqual(matchingEquipment(sorted, '紅色', false, character, metadata).map((item) => item.name), ['紅色頭盔', '紅色帽子', '紅色面罩']);
  assert.deepEqual(matchingEquipment(sorted, '', true, { race: 2, gender: 1 }, metadata).map((item) => item.name), ['紅色頭盔', '紅色帽子']);
  assert.equal(matchingEquipment(sorted, '', true, null, metadata).length, sorted.length);
});

test('穿搭文字按固定部位排列，顯示遮擋與實際染色格且不包含檔名或路徑', () => {
  const actual = outfitText(
    [['Head', '頭部'], ['Top', '身體'], ['Ear', '耳飾']],
    { Head: { name: '長帽', dye: 2 } },
    { Top: { name: '預設上衣', dye: 1 } },
    { Head: 'Top' },
    { Head: [4, 0], Top: [2, 3] },
    { name: (id) => ({ 0: '不染', 2: '藍染劑', 4: '紅染劑' })[id] },
  );
  assert.equal(actual, '頭部：長帽（被身體裝備遮住）｜染劑 1：紅染劑、染劑 2：不染\n身體：預設上衣｜染劑 1：藍染劑\n耳飾：未穿戴');
});

test('未知總量的網站與畫面進度不聲稱百分比', () => {
  const panel = new DownloadPanel({ addEventListener() {} }, { indoor: '室內' });
  panel.items.indoor = {
    phase: 'download', total: 0, loaded: 1e6, clientLoaded: 0, clientTotal: 0,
    clientDone: 0, clientFiles: 0, files: 0, doneFiles: 0, startedAt: performance.now(),
  };
  const downloading = panel.activeLines('indoor');
  assert.match(downloading, /codex-progress--indeterminate/);
  assert.doesNotMatch(downloading, /aria-valuenow=/);
  assert.match(downloading, /網站資料.*本機遊戲資料/s);
  panel.items.indoor.phase = 'compile';
  panel.items.indoor.compileStartedAt = performance.now();
  const compiling = panel.activeLines('indoor');
  assert.match(compiling, /準備畫面/);
  assert.match(compiling, /著色器 準備中/);
  assert.doesNotMatch(compiling, /aria-valuenow=/);
});
