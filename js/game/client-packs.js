// 背景與裝備資料只從玩家指定的台服遊戲檔案讀取；不讀取整個 datN，也不上傳任何本機檔案。
import { SqPack } from './sqpack.js';
import { pickSqpackFiles } from '../app/sqpack-pick.js';

export const REQUIRED_PACKS = ['000000', '010000', '020000', '040000', '050000'];
const FILE_NAME = /^(000000|010000|020000|040000|050000)\.win32\.(index|dat(\d+))$/;

export async function openClientPacks(fileList) {
  const files = pickSqpackFiles(fileList, FILE_NAME);
  const byName = new Map(files.map(file => [file.name, file]));
  if (byName.size !== files.length) throw new Error('選到重複的遊戲資料檔案，請只選同一份安裝資料夾');
  const packs = {};
  for (const category of REQUIRED_PACKS) {
    const index = byName.get(`${category}.win32.index`);
    const dat0 = byName.get(`${category}.win32.dat0`);
    if (!index || !dat0) throw new Error(`找不到 ${category}.win32.index 或 dat0，請選台服遊戲安裝資料夾`);
    const dats = [];
    for (const file of files) {
      const match = new RegExp(`^${category}\\.win32\\.dat(\\d+)$`).exec(file.name);
      if (match) dats[Number(match[1])] = file;
    }
    packs[category] = new SqPack(index, dats);
    await packs[category].init();
  }
  packs.chara = packs['040000'];
  packs.shader = packs['050000'];
  return { packs, files };
}
