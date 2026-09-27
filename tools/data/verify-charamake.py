"""核對本機 14 個外貌資料與 data/race-pose/<四位模型碼>.json 各種族預設值是否在台服建立角色選項內。
用法：從 repo 根目錄執行 python tools/data/verify-charamake.py。
"""
import csv
import glob
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POSE_DIR = ROOT / 'data/race-pose'
SAVES = 'C:/Users/shawn_lin/Documents/My Games/FINAL FANTASY XIV - TC/FFXIV_CHARA_*.dat'
# race-pose 拆檔檔名為四位數字模型碼（0101.json），對照 charamake 的 c0101
pose = {f'c{p.stem}': json.loads(p.read_text(encoding='utf-8')) for p in sorted(POSE_DIR.glob('[0-9][0-9][0-9][0-9].json'))}
assert len(pose) == 18, f'預期 18 個 race-pose 檔，實際 {len(pose)}'
assert not (ROOT / 'data/race-pose.json').exists(), '舊全量 race-pose.json 未移除'
keys = {p.stem for p in (ROOT / 'data/charamake').glob('c????.json')}
assert keys == pose.keys(), (keys - pose.keys(), pose.keys() - keys)
assert not (ROOT / 'data/charamake.json').exists(), '舊全量 charamake.json 未移除'
options = {key: json.loads((ROOT / 'data/charamake' / f'{key}.json').read_text(encoding='utf-8')) for key in keys}
with Path('C:/FFXIVProject/data/item_dict/datamining_tc/tclocal_Item.csv').open(encoding='utf-8-sig', newline='') as source:
    item_names = {int(row[0]): row[1] for row in csv.reader(source) if len(row) > 1 and row[0].isdigit() and row[1]}
named_hair = 0
for variants in options.values():
    for option in variants.values():
        for hair in option['hair']['options']:
            name = item_names.get(hair['unlockItem'])
            assert hair.get('unlockName') == name if name else 'unlockName' not in hair, hair
            named_hair += bool(name)
unreleased = [hair for variants in options.values() for option in variants.values()
              for hair in option['hair']['options'] if hair['id'] == 187 and hair['unlockItem'] == 46798]
assert unreleased and all('unlockName' not in hair for hair in unreleased)
print('有台服解鎖道具名稱的髮型選項:', named_hair)


def code(c):
    race, gender, clan = c[0], c[1], c[4]
    if race == 1:
        return f'c{(101 if gender == 0 else 201) if clan == 1 else (301 if gender == 0 else 401):04}'
    return f'c{({2: (501, 601), 3: (1101, 1201), 4: (701, 801), 5: (901, 1001), 6: (1301, 1401), 7: (1501, 1601), 8: (1701, 1801)}[race][gender]):04}'


def check(label, c):
    k = code(c)
    row = options[k][f'{c[4]}-{c[1]}']
    for group, value in [('faces', c[5]), ('hair', c[6]), ('facePaint', c[24] & 0x7f),
                         ('raceFeature', c[22])]:
        if group == 'raceFeature' and row[group] is None:
            continue
        found = [o for o in row[group]['options'] if o['id'] == value]
        if not found:
            misses.append((label, k, group, value))
        elif group == 'hair' and label.startswith('存檔'):
            hair_types['解鎖髮型' if found[0]['unlockable'] else '預設髮型'] += 1
    checked[k] += 1


checked, hair_types, misses = Counter(), Counter(), []
for key, value in pose.items():
    c = value['customize']
    assert key == code(c), (key, code(c))
    check(f'預設 {key}', c)
files = sorted(glob.glob(SAVES))
assert len(files) == 14, f'預期 14 個外貌存檔，實際 {len(files)}'
for file in files:
    data = Path(file).read_bytes()
    assert len(data) == 212 and int.from_bytes(data[:4], 'little') == 0x2013ff14, file
    check(f'存檔 {Path(file).name}', data[16:42])
print('逐模型檢查:', dict(sorted(checked.items())))
print('存檔髮型:', dict(hair_types))
print('選項之外:', misses)
if misses:
    raise SystemExit(1)
