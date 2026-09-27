// 種族骨架變形（chara/xls/boneDeformer/human.pbd）：別的種族的模型套到這個角色的骨架時，每根骨頭先乘一個變形矩陣。
// 格式與組合順序對照 Penumbra.GameData PbdFile／RacialDeformer（Penumbra 1.5.1.26 反組譯）：
//   檔頭 i32 數量；每個 u16 種族碼、i16 樹節點、i32 資料位移、f32；接著樹節點 (i16 父, 首子, 次兄弟, 變形序號)。
//   變形資料：i32 骨數、u16 字串位移（相對資料起點）、奇數時補 u16、再來骨數 × row-major 3×4 float。
//   骨架種族 S 套模型種族 M：從 S 的變形起，沿父節點往上直到 M，每一層 D ← D · D_父；遊戲的骨架矩陣＝J_S · D
//   （2026-09-26 以擷取驗證：c0201 模型 5 根骨誤差 1.5e-7、c0101 戒指 2 根骨 7.5e-8；Penumbra Append 的反向順序誤差 4.5e-3）。
//   S 的變形沒有、只有上層有的骨頭照 Penumbra 不補（未驗證，列在 missingInSkeleton）。
export const PBD_PATH = 'chara/xls/boneDeformer/human.pbd';

function cstr(bytes, off) {
  let e = off;
  while (e < bytes.length && bytes[e] !== 0) e++;
  return new TextDecoder().decode(bytes.subarray(off, e));
}

export function parsePbd(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getInt32(0, true);
  const deformers = [];
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 12;
    const race = dv.getUint16(o, true), tree = dv.getInt16(o + 2, true), offset = dv.getInt32(o + 4, true), scale = dv.getFloat32(o + 8, true);
    const matrices = new Map();
    if (offset) {
      const count = dv.getInt32(offset, true);
      const names = [];
      for (let b = 0; b < count; b++) names.push(cstr(bytes, offset + dv.getUint16(offset + 4 + b * 2, true)));
      let m = offset + 4 + count * 2 + (count & 1 ? 2 : 0);
      for (const name of names) {
        matrices.set(name, Float64Array.from({ length: 12 }, (_, k) => dv.getFloat32(m + k * 4, true)));
        m += 48;
      }
    }
    deformers.push({ race, tree, scale, matrices });
  }
  const treeBase = 4 + n * 12;
  const tree = Array.from({ length: n }, (_, i) => ({
    parent: dv.getInt16(treeBase + i * 8, true), deformer: dv.getInt16(treeBase + i * 8 + 6, true),
  }));
  return { deformers, tree };
}

/** g_ModelParameter.x：骨架種族與模型種族的 pbd 比例相除（2026-09-26 擷取驗證：c0201 模型 0.9638、c0101 0.8955、同種族 1） */
export function modelScale(pbd, skeletonRace, modelRace) {
  const s = (race) => pbd.deformers.find(d => d.race === race)?.scale;
  return skeletonRace === modelRace ? 1 : s(skeletonRace) / s(modelRace);
}

/** row-major 3×4（第 4 列 0 0 0 1）相乘：a·b */
export function mul34(a, b) {
  const o = new Float64Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let s = c === 3 ? a[r * 4 + 3] : 0;
      for (let k = 0; k < 3; k++) s += a[r * 4 + k] * b[k * 4 + c];
      o[r * 4 + c] = s;
    }
  }
  return o;
}

/** 骨架種族 skeletonRace 上顯示 modelRace 的模型：骨名 → 變形矩陣（沒有的骨頭＝單位矩陣，不列） */
export function racialDeformer(pbd, skeletonRace, modelRace) {
  const out = new Map();
  out.missingInSkeleton = new Set();
  if (skeletonRace === modelRace) return out;
  const byRace = (race) => { const d = pbd.deformers.find(x => x.race === race); if (!d) throw new Error(`pbd 沒有種族 ${race}`); return d; };
  const parentOf = (d) => { const p = pbd.tree[d.tree].parent; if (p < 0) throw new Error(`種族 ${modelRace} 不在 ${skeletonRace} 的上層`); return pbd.deformers[pbd.tree[p].deformer]; };
  const start = byRace(skeletonRace);
  for (const [name, m] of start.matrices) out.set(name, m);
  for (let p = parentOf(start); p.race !== modelRace; p = parentOf(p)) {
    for (const [name, m] of p.matrices) {
      if (out.has(name)) out.set(name, mul34(out.get(name), m));
      else out.missingInSkeleton.add(name);
    }
  }
  return out;
}
