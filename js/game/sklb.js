// 骨架檔（.sklb）：取出 hkaSkeleton 的骨名、parentIndices、referencePose，給網頁端自己算姿勢／額外骨架。
// 檔頭（台服 client 實測三種版本；Havok 位移都以該處有 tagfile magic 驗過）：
//   0x00 "blks"、0x04 版本字串；"0031"／"1031"：0x08 u32 hpla（動畫圖層）區段位移（0x30）、0x0C u32 Havok 資料位移；
//   "0021"：0x08 u16 hpla 位移（0x2E）、0x0A u16 Havok 位移。
//   "0031" 0x10 u32＝額外骨架根骨（第 0 根）接在主骨架（base）的骨頭編號（主骨架自己是 0xFFFF）。2026-09-26 驗證：全種族 EST 列到的
//   0031 sklb 與 c0801 base 骨名比，根骨同名者一律等於同名骨的編號（除 c0104 系 NPC 種族，base 骨序不同）；唯一不同名的是
//   t0100 系（根骨 n_ex_top，主骨架沒有這根）→ 22＝j_sebo_c，與姿勢傾印 capture-20260926-092611 的 connectedParentBone＝22 一致。
//   其餘欄位（0x14 種族碼、"1031" 0x28 起的 u16 串…）語意未查證，這裡不讀；其他版本直接丟錯，不猜版面。
// Havok 資料＝舊版 binary tagfile（magic u32 0xCAB00D1E、0xD011FACE，file info version 3），讀法照 exyorha/hkxparse
// HKXTagfileParser.cpp／Deserializer.cpp／TagfileTypes.h：
//   varint：首位元組 bit0＝負號、bit1–6＝低 6 位，0x80＝續，之後每位元組 7 位；
//   tag：1 file info（version；3/4 時字串表先放 2 個空項，4 另有版本字串）、2 metadata（類別定義）、
//        4 object remember（依序配 1,2,3… 的物件編號）、7 file end；
//   字串：varint 長度，>0 新字串（加入字串表）、≤0 參照字串表第 -len 項；
//   類別：名稱、版本、父類別序號（0＝無）、成員數，每個成員：名稱、型別（低 4 位基本型別｜0x10 陣列｜0x20 tuple〔再讀 tuple 長度〕，
//        object／struct 再讀類別名）；物件：類別序號、(父類別成員在前的總成員數＋7)/8 位元組的「有寫出」位元圖，再依序讀有寫的成員；
//   值：byte 1 位元組、int varint、real f32、vec4/8/12/16 為 4/8/12/16 個 f32、object＝物件編號（0＝null）、cstring 字串；
//        陣列：varint 長度，int 陣列先讀元素寬度、vec4 陣列先讀分量數，byte 陣列是原始位元組；
//        struct 陣列按欄存：先位元圖，再每個有寫的成員各一整段陣列。
// referencePose 每骨 hkQsTransform＝平移 xyzw、旋轉 xyzw、縮放 xyzw（12 float），輸出去掉兩個 w 成 10 float。
// 驗證（tmp/verify-sklb.mjs，2026-09-26）：ShaderProbe 姿勢傾印 32 個角色 127 個 partial、6193 根骨的 bones／parents 全等，
//   reference 最大差 5.2e-8（傾印 JSON 的 float 取整）；全種族 base＋EST 列到的 9145 個 sklb 全部解析成功。
//   注意：上衣骨架可有多個根（例 t0377：j_ude_b_l、j_ude_b_r 都是 parent -1）。
const TAG_FILE_INFO = 1, TAG_METADATA = 2, TAG_OBJECT = 3, TAG_OBJECT_REMEMBER = 4, TAG_FILE_END = 7;
const T_BYTE = 1, T_INT = 2, T_REAL = 3, T_VEC4 = 4, T_VEC8 = 5, T_VEC12 = 6, T_VEC16 = 7, T_OBJECT = 8, T_STRUCT = 9, T_CSTRING = 10;
const BASIC = 15, ARRAY = 16, TUPLE = 32;
const VEC_FLOATS = { [T_VEC4]: 4, [T_VEC8]: 8, [T_VEC12]: 12, [T_VEC16]: 16 };

/** sklb 檔頭 → { version, layerOffset, havokOffset, connect }（connect＝根骨接點的主骨架骨頭編號，只有 "0031" 有；沒有＝null） */
export function sklbHeader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4)), version = String.fromCharCode(...bytes.subarray(4, 8));
  if (magic !== 'blks') throw new Error(`不是 sklb（magic ${magic}）`);
  if (version === '0021') return { version, layerOffset: dv.getUint16(8, true), havokOffset: dv.getUint16(10, true), connect: null };
  if (version === '0031' || version === '1031') {
    const connect = version === '0031' ? dv.getUint32(16, true) : 0xffff;
    return { version, layerOffset: dv.getUint32(8, true), havokOffset: dv.getUint32(12, true), connect: connect >= 0xffff ? null : connect };
  }
  throw new Error(`未支援的 sklb 版本 ${version}`);
}

/** Havok binary tagfile → 物件表（編號 → { class, fields }） */
export function parseTagfile(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0xCAB00D1E || dv.getUint32(4, true) !== 0xD011FACE) throw new Error('不是 Havok binary tagfile');
  let p = 8;
  const byte = () => { if (p >= bytes.length) throw new Error('tagfile 讀超過結尾'); return bytes[p++]; };
  const varint = () => {
    let b = byte();
    const neg = b & 1;
    let v = (b & 0x7e) >> 1, shift = 6;
    while (b & 0x80) { b = byte(); v += (b & 0x7f) * 2 ** shift; shift += 7; }
    return neg ? -v : v;
  };
  const f32 = () => { const v = dv.getFloat32(p, true); p += 4; return v; };
  const floats = n => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = f32(); return o; };
  let strings = ['', null];
  const string = () => {
    const len = varint();
    if (len <= 0) return strings[-len];
    const s = new TextDecoder().decode(bytes.subarray(p, p + len));
    p += len;
    strings.push(s);
    return s;
  };
  const types = [{ name: null, parent: 0, members: [] }];
  const typeByName = new Map();
  const allMembers = ti => (ti ? [...allMembers(types[ti].parent), ...types[ti].members] : []);
  const objects = new Map();
  let nextId = 1;

  const value = (m, prefix) => {
    const t = m.type & BASIC;
    switch (t) {
      case T_BYTE: return byte();
      case T_INT: return varint();
      case T_REAL: return f32();
      case T_VEC4: return floats(prefix > 0 ? prefix : 4);
      case T_VEC8: case T_VEC12: case T_VEC16: return floats(VEC_FLOATS[t]);
      case T_OBJECT: return varint();
      case T_STRUCT: return struct(typeIndex(m.className));
      case T_CSTRING: return string();
      default: throw new Error(`未支援的 tagfile 型別 ${m.type}（${m.name}）`);
    }
  };
  const typeIndex = name => {
    const i = typeByName.get(name);
    if (i === undefined) throw new Error(`tagfile 找不到類別 ${name}`);
    return i;
  };
  const bitmap = n => { const o = bytes.subarray(p, p + ((n + 7) >> 3)); p += (n + 7) >> 3; return i => (o[i >> 3] >> (i & 7)) & 1; };
  const items = (m, n) => {
    const t = m.type & BASIC;
    if (t === T_BYTE) { const o = bytes.slice(p, p + n); p += n; return o; }
    if (t === T_STRUCT) return structArray(m, n);
    const prefix = t === T_INT || t === T_VEC4 ? varint() : -1;
    return Array.from({ length: n }, () => value(m, prefix));
  };
  const field = m => {
    if (m.type & ~(ARRAY | TUPLE | BASIC) || (m.type & ARRAY && m.type & TUPLE)) throw new Error(`未支援的 tagfile 成員型別 ${m.type}（${m.name}）`);
    if (m.type & TUPLE) return items(m, m.tupleSize);
    if (m.type & ARRAY) return items(m, varint());
    return value(m, -1);
  };
  function struct(ti) {
    const members = allMembers(ti);
    const has = bitmap(members.length);
    const fields = {};
    members.forEach((m, i) => { if (has(i)) fields[m.name] = field(m); });
    return { class: types[ti].name, fields };
  }
  function structArray(m, n) {
    const ti = typeIndex(m.className);
    const members = allMembers(ti);
    const has = bitmap(members.length);
    const out = Array.from({ length: n }, () => ({ class: types[ti].name, fields: {} }));
    members.forEach((mm, i) => {
      if (!has(i)) return;
      // 欄存的成員本身是陣列／tuple 時 hkxparse 也沒處理，版面不明：不猜，直接丟錯
      if (mm.type & (ARRAY | TUPLE)) throw new Error(`未支援：struct 陣列裡的陣列成員 ${m.className}.${mm.name}`);
      const col = items(mm, n);
      out.forEach((o, k) => { o.fields[mm.name] = col[k]; });
    });
    return out;
  }

  for (;;) {
    const tag = varint();
    if (tag === TAG_FILE_INFO) {
      const version = varint();
      if (version !== 3 && version !== 4) throw new Error(`未支援的 tagfile 版本 ${version}`);
      strings = ['', null];
      if (version === 4) string();
    } else if (tag === TAG_METADATA) {
      const name = string(), version = varint(), parent = varint(), count = varint();
      const members = [];
      for (let i = 0; i < count; i++) {
        const m = { name: string(), type: varint() };
        if (m.type & TUPLE) m.tupleSize = varint();
        const t = m.type & BASIC;
        if (t === T_OBJECT || t === T_STRUCT) m.className = string();
        members.push(m);
      }
      types.push({ name, version, parent, members });
      typeByName.set(name, types.length - 1);
    } else if (tag === TAG_OBJECT_REMEMBER || tag === TAG_OBJECT) {
      const obj = struct(varint());
      if (tag === TAG_OBJECT_REMEMBER) objects.set(nextId++, obj);
    } else if (tag === TAG_FILE_END) {
      break;
    } else {
      throw new Error(`未支援的 tagfile tag ${tag}（位移 ${p + 8}）`);
    }
  }
  return objects;
}

/** sklb → { name, bones, parents, reference, connect }；取 hkRootLevelContainer → hkaAnimationContainer.skeletons[0]；connect 見 sklbHeader */
export function parseSklb(bytes) {
  const { havokOffset, connect } = sklbHeader(bytes);
  const objects = parseTagfile(bytes.subarray(havokOffset));
  const root = objects.get(1);
  if (root?.class !== 'hkRootLevelContainer') throw new Error(`sklb 根物件不是 hkRootLevelContainer（${root?.class}）`);
  const variant = (root.fields.namedVariants ?? []).find(v => v.fields.className === 'hkaAnimationContainer');
  const container = variant && objects.get(variant.fields.variant);
  const skeleton = container && objects.get(container.fields.skeletons?.[0]);
  if (skeleton?.class !== 'hkaSkeleton') throw new Error('sklb 找不到 hkaAnimationContainer.skeletons[0]');
  const f = skeleton.fields;
  const bones = (f.bones ?? []).map(b => b.fields.name);
  const n = bones.length;
  const parents = Int16Array.from(f.parentIndices ?? []);
  const pose = f.referencePose ?? [];
  if (parents.length !== n || pose.length !== n) throw new Error(`sklb 骨數不一致：bones ${n}、parents ${parents.length}、referencePose ${pose.length}`);
  const reference = new Float32Array(n * 10);
  pose.forEach((q, i) => { reference.set(q.subarray(0, 3), i * 10); reference.set(q.subarray(4, 8), i * 10 + 3); reference.set(q.subarray(8, 11), i * 10 + 7); });
  return { name: f.name ?? '', bones, parents, reference, connect };
}

/** reference 第 o 個 float 起的 10 float（平移 xyz、旋轉 xyzw、縮放 xyz）→ T·R·S，row-major 3×4 */
export function qs34(f, o) {
  const tx = f[o], ty = f[o + 1], tz = f[o + 2], x = f[o + 3], y = f[o + 4], z = f[o + 5], w = f[o + 6], sx = f[o + 7], sy = f[o + 8], sz = f[o + 9];
  return Float64Array.from([
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y - z * w) * sy, 2 * (x * z + y * w) * sz, tx,
    2 * (x * y + z * w) * sx, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z - x * w) * sz, ty,
    2 * (x * z - y * w) * sx, 2 * (y * z + x * w) * sy, (1 - 2 * (x * x + y * y)) * sz, tz,
  ]);
}

/** row-major 3×4 仿射反矩陣 */
export function inverse34(m) {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const r = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d].map(v => v / det);
  return Float64Array.from([
    r[0], r[1], r[2], -(r[0] * tx + r[1] * ty + r[2] * tz),
    r[3], r[4], r[5], -(r[3] * tx + r[4] * ty + r[5] * tz),
    r[6], r[7], r[8], -(r[6] * tx + r[7] * ty + r[8] * tz),
  ]);
}

const mul = (a, b) => {
  const o = new Float64Array(12);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
    let s = c === 3 ? a[r * 4 + 3] : 0;
    for (let k = 0; k < 3; k++) s += a[r * 4 + k] * b[k * 4 + c];
    o[r * 4 + c] = s;
  }
  return o;
};

/** 參考姿勢沿父骨累乘成骨架模型空間（RefModel），每骨 row-major 3×4 */
export function referenceModel(sklb) {
  const out = [];
  sklb.bones.forEach((_, b) => {
    const local = qs34(sklb.reference, b * 10);
    out[b] = sklb.parents[b] >= 0 ? mul(out[sklb.parents[b]], local) : local;
  });
  return out;
}
