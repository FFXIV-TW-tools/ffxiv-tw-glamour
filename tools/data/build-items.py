"""台服 client Item 結構＋tclocal_Item.csv 名稱 → 分部位裝備與預設服裝。從 repo 根目錄執行：python tools/data/build-items.py。

此命令會呼叫 Lumina 匯出 Item 結構與 ClassJobCategory／角色製作資料，從頭重生所有相依 JSON。
"""
import csv
import json
from collections import Counter
from pathlib import Path
import subprocess

NAMES = Path('C:/FFXIVProject/data/item_dict/datamining_tc/tclocal_Item.csv')
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data' / 'items'
CLIENT = ROOT / 'tools' / 'data' / 'tmp' / 'client-items.json'
EXPORTER = ['dotnet', 'run', '--project', 'tools/data/charamake-export', '-c', 'Release', '--']
SLOTS = ('met', 'top', 'glv', 'dwn', 'sho', 'ear', 'nek', 'wrs', 'rir')
SLOT = {3: 'met', 4: 'top', 5: 'glv', 7: 'dwn', 8: 'sho',
        15: 'top', 16: 'top', 18: 'dwn', 19: 'top', 20: 'top', 21: 'top', 22: 'top', 23: 'top',
        9: 'ear', 10: 'nek', 11: 'wrs', 12: 'rir'}
BLOCKS = {15: ['met'], 16: ['glv', 'dwn', 'sho'], 18: ['sho'], 19: ['met', 'glv', 'dwn', 'sho'],
          20: ['glv', 'dwn'], 21: ['dwn', 'sho'], 22: ['glv'], 23: ['dwn']}
FIELDS = ['id', 'name', 'set', 'variant', 'blocks', 'dye', 'icon', 'ilvl', 'equipLevel',
          'rarity', 'restriction', 'job']
# data/race-pose/<模型碼>.json 的 equipment 欄名 → 部位檔；左右戒指共用 rir（同 js/app/slot-data.js slotCode）。
PRESET_SLOT = {'Head': 'met', 'Top': 'top', 'Arms': 'glv', 'Legs': 'dwn', 'Feet': 'sho',
               'Ear': 'ear', 'Neck': 'nek', 'Wrist': 'wrs', 'RFinger': 'rir', 'LFinger': 'rir'}

# EquipRestriction：台服 client Item 初始服名稱與實際模型路徑雙重核對。
# 跑 `dotnet run --project tools/data/charamake-export -c Release -- restriction-probe` 可重查 set → directModels。
# 2／3 共用 e0059 模型路徑，因此性別由「君子／淑女、男式／女式」等物品名稱核對，不由模型推斷。
# 4／5 的人族男／女服、6–15 的各族服、16–19 的硌獅／維艾拉服都有族性別限定名稱。
RESTRICTION_EXAMPLES = {
    1: (366, []), 2: (2967, []), 3: (2970, []),
    4: (2983, [101, 301]), 5: (2984, [201]), 6: (2985, [501]), 7: (2986, [601]),
    8: (2987, [1101]), 9: (2988, [1201]), 10: (2989, [701]), 11: (2990, [801]),
    12: (2991, [901]), 13: (2992, [1001]), 14: (9645, [1301]), 15: (9649, [1401]),
    16: (25212, [1501]), 17: (25208, [1801]), 18: (33943, [1701]), 19: (41790, [1601]),
}
RESTRICTION_ALLOWED = {
    1: (list(range(1, 9)), [0, 1]),
    2: (list(range(1, 9)), [0]), 3: (list(range(1, 9)), [1]),
    **{4 + (race - 1) * 2 + gender: ([race], [gender])
       for race in range(1, 7) for gender in (0, 1)},
    16: ([8], [0]), 17: ([7], [1]), 18: ([7], [0]), 19: ([8], [1]),
}


def build_restrictions(rows):
    all_rows = [r for group in rows.values() for r in group]
    observed = sorted({r[10] for r in all_rows})
    by_id = {r[0]: r for r in all_rows}
    values = {}
    for value in observed:
        if value not in RESTRICTION_ALLOWED:
            continue
        example, direct_models = RESTRICTION_EXAMPLES[value]
        item = by_id[example]
        assert item[10] == value, (example, value, item[10])
        races, genders = RESTRICTION_ALLOWED[value]
        values[value] = {'raceIds': races, 'genders': genders,
                         'example': {'itemId': item[0], 'name': item[1], 'set': item[2]},
                         'directModels': [f'c{code:04}' for code in direct_models]}
    unknown = [value for value in observed if value not in RESTRICTION_ALLOWED]
    write_json(ROOT / 'data' / 'equip-restriction.json', {'values': values, 'unknown': unknown})
    print('unknown restrictions:', unknown)
    return values


def build_preset(rows, restrictions):
    """各種族角色製作畫面的預設服裝 → data/items/preset.json：未展開部位清單也能顯示名稱、圖示與等級。

    同一個 set-variant 有多件物品時取部位檔中第一筆（台服 client Item 列順序＝物品 id 由小到大，下方斷言核對），
    與面板展開清單前的舊挑法（部位清單 Array.find）一致。附上這些物品用到的職業、限制與種族名稱，
    格式同 js/app/slot-data.js slotMetadata()，不必另外下載三份資料。
    """
    wanted = {}
    for path in sorted((ROOT / 'data' / 'race-pose').glob('*.json')):
        for slot, gear in json.loads(path.read_text(encoding='utf-8'))['equipment'].items():
            if gear['set']:
                wanted.setdefault(PRESET_SLOT[slot], set()).add((gear['set'], gear['variant']))
    slots, missing = {}, []
    for code in sorted(wanted):
        ids = [r[0] for r in rows[code]]
        assert ids == sorted(ids), f'{code} 部位檔不是依物品 id 排序'
        picked = []
        for model in sorted(wanted[code]):
            row = next((r for r in rows[code] if (r[2], r[3]) == model), None)
            if row:
                picked.append(row)
            else:
                missing.append(f'{code} {model[0]}-{model[1]}')
        slots[code] = picked
    used = [r for picked in slots.values() for r in picked]
    jobs = json.loads((ROOT / 'data' / 'job-categories.json').read_text(encoding='utf-8'))
    races = json.loads((ROOT / 'data' / 'races.json').read_text(encoding='utf-8'))['races']
    write_json(OUT / 'preset.json', {
        'fields': FIELDS, 'slots': slots,
        'jobs': {str(job): jobs[str(job)] for job in sorted({r[11] for r in used}) if str(job) in jobs},
        'restrictions': {'values': {value: restrictions[value] for value in sorted({r[10] for r in used}) if value in restrictions}},
        'raceNames': {race_id: name for race_id, name, _ in races},
    })
    print(f'  preset: {len(used)} rows; missing: {missing}')


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8', newline='')
    print(f'{path.name}: {path.stat().st_size} bytes')


def main():
    subprocess.run([*EXPORTER, 'items', str(CLIENT)], cwd=ROOT, check=True)
    with NAMES.open(encoding='utf-8-sig', newline='') as source:
        names = {int(row[0]): row[1] for row in csv.reader(source) if len(row) > 1 and row[0].isdigit()}
    client = json.loads(CLIENT.read_text(encoding='utf-8'))
    client_ids = {entry[0] for entry in client}
    if client_ids != names.keys():
        raise ValueError(f'台服 client 與 tclocal id 不一致：client 獨有 {sorted(client_ids - names.keys())}；tclocal 獨有 {sorted(names.keys() - client_ids)}')
    mismatches = [(entry[0], entry[1], names[entry[0]]) for entry in client if entry[1] != names[entry[0]]]
    print(f'client 名稱 ≠ tclocal 名稱：{len(mismatches)} 列')
    for item_id, client_name, local_name in mismatches:
        print(f'  {item_id}: client {client_name!r} => tclocal {local_name!r}')
    rows = {slot: [] for slot in SLOTS}
    for item_id, _, cat, set_id, variant, dye, icon, ilvl, level, rarity, restriction, job in client:
        if cat not in SLOT or not set_id or not names[item_id]:
            continue
        rows[SLOT[cat]].append([item_id, names[item_id], set_id, variant, BLOCKS.get(cat, []),
                                dye, icon, ilvl, level, rarity, restriction, job])
    for slot, values in rows.items():
        write_json(OUT / f'{slot}.json', {'fields': FIELDS, 'rows': values})
        print(f'  {slot}: {len(values)} rows')
    subprocess.run([*EXPORTER, 'export', '.', '--no-reference'], cwd=ROOT, check=True)
    print('restriction:', dict(sorted(Counter(r[10] for rs in rows.values() for r in rs).items())))
    build_preset(rows, build_restrictions(rows))


if __name__ == '__main__':
    main()
