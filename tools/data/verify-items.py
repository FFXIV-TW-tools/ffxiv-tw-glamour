"""核對現行台服 client 的裝備資料與 tclocal 名稱，含保鑣背心缺漏回歸。
用法：從 repo 根目錄執行 python tools/data/verify-items.py（先跑 build-items.py）。
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAMES = Path('C:/FFXIVProject/data/item_dict/datamining_tc/tclocal_Item.csv')
SLOT = {3: 'met', 4: 'top', 5: 'glv', 7: 'dwn', 8: 'sho',
        9: 'ear', 10: 'nek', 11: 'wrs', 12: 'rir',
        15: 'top', 16: 'top', 18: 'dwn', 19: 'top',
        20: 'top', 21: 'top', 22: 'top', 23: 'top'}
with NAMES.open(encoding='utf-8-sig', newline='') as source:
    names = {int(row[0]): row[1] for row in csv.reader(source) if len(row) > 1 and row[0].isdigit()}
client = {row[0]: row for row in json.loads((ROOT / 'tools/data/tmp/client-items.json').read_text(encoding='utf-8'))}
slots = {}
for code in ('met', 'top', 'glv', 'dwn', 'sho', 'ear', 'nek', 'wrs', 'rir'):
    data = json.loads((ROOT / 'data/items' / f'{code}.json').read_text(encoding='utf-8'))
    assert data['fields'] == ['id', 'name', 'set', 'variant', 'blocks', 'dye', 'icon', 'ilvl',
                              'equipLevel', 'rarity', 'restriction', 'job']
    slots[code] = {row[0]: row for row in data['rows']}
    assert len(slots[code]) == len(data['rows']), code
    for row in data['rows']:
        source = client[row[0]]
        assert row[1] == names[row[0]], row[0]
        assert [row[i] for i in (2, 3, 5, 6, 7, 8, 9, 10, 11)] == source[3:12], row[0]
        assert code == SLOT[source[2]], row[0]
for item_id, name, icon in [(47919, '保鑣槍帶背心', 57242), (47920, '保鑣背心', 57243)]:
    row = slots['top'][item_id]
    assert (row[1], row[6], row[7], row[9]) == (name, icon, 1, 1), row
    print(f'{item_id}: {row[1]} icon={row[6]} ilvl={row[7]} rarity={row[9]}')
print('九部位:', {code: len(rows) for code, rows in slots.items()})
print('全數裝備：名稱來自 tclocal、結構欄位與 client 一致')
