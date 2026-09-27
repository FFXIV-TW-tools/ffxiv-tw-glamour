// 開發用（曲面細分重播）：WebGL2 沒有 HS／DS 階段 → 直接畫 ShaderProbe 重送的 DS 輸出頂點（第 14 版擷取 draws[].tess；
// 頂點＝snapshots[tess.snapshot]（when:'tessellated'），依圖元順序展開成 list、每圖元 verticesPerPrimitive 個，內容＝DS 輸出，SV_POSITION 已是 D3D clip space）。
// manifest（tools/build-replay-frame.mjs 產生；op.vs＝'tess'）：geometry[key] = { kind:'tess', vb:{file|url}, count, stride, topology:4, elements }，
// elements 原樣＝[semantic, semIndex, register, systemValue, componentType, startComponent, componentCount, byteOffset]。
// 規則：
// - pass-through VS：每個 DS 輸出元素一個頂點屬性（componentType 1 uint／2 sint／3 float，D3D_REGISTER_COMPONENT_TYPE）。
//   SV_POSITION（systemValue 1＝D3D_NAME_POSITION）→ gl_Position，換算同 tools/dxbc2glsl.mjs VS 結尾（y 翻轉、xiv_ndc_offset、z [0,w]→[−w,w]）；
//   其餘元素依暫存器組回整個 vec4（startComponent 起放 componentCount 個分量），寫給 PS 同暫存器的 varying（io_<語意><索引>；
//   同 dxbc2glsl VS：一個暫存器打包多語意時各 varying 拿整個暫存器，PS 自取遮罩分量）。
// - 與 PS 輸入簽章逐一對上：PS 每個有 varying 的輸入，DS 同暫存器要有同語意＋索引的元素、整數／浮點相同、PS 用到的分量（簽章 Used 欄）DS 都有輸出；
//   插值修飾（flat／centroid）照 PS 宣告。任何一項對不上 → 丟錯（frame.js 記 log、整筆不畫；不猜）。
// - 放大（js/engine/game-view.js 投影裁切 K，clip′＝K·clip，只改投影、相機不動）：DS 輸出已投影，改在 VS 對 SV_POSITION 左乘 K
//   ＝等效於 DS 用裁切後的投影矩陣。DS 輸出中每個頂點都與 SV_POSITION 逐位元相同的元素（clip 座標副本；river／water 的 TEXCOORD7）同樣左乘 K
//   （遊戲 DS 以同一個投影算出它）。K 取 replay.clipCrop（列優先 16 個數；null＝不放大）。
//   限制：遊戲的曲面細分係數依畫面大小決定，放大時遊戲會切得更細；這裡沿用擷取時的切分（形狀同、細節不增加）。
// 驗證（2026-09-26，第 14 版擷取 海岸 3／森林 24／荒野 57 筆；tmp/tess-check/ 單組小包＋CPU 光柵化對照）：
// - 遊戲前後快照：三個背景的水面（river／water 三個 pass）在美容師鏡頭下全被地形遮住，G-buffer／光照緩衝／深度都 0 像素改變；
//   逐頂點查遊戲深度也全數在後面。我方重播同樣 0 像素改變、無 GL 錯誤。
// - 位置：深度比較改 ALWAYS 後，我方覆蓋與寫入深度對「D3D 視埠換算＋螢幕空間重心內插 z/w」的 CPU 光柵化逐像素一致
//   （覆蓋差 ≤1 像素、深度差 ≤1.6 個 D24 單位），放大 2×（K）亦同；game-view cropProjection 的放大對背景繪圖的效果＝同一個 K（主深度逐像素對照）。
import { compileProgram } from '../game/xivgl/pass.js';

const shaderDecoder = new TextDecoder();

const POSITION = 1; // D3D_NAME_POSITION
const LETTERS = 'xyzw';
const COMPONENT = {
  1: { glsl: 'uvec', scalar: 'uint', pointer: 'UNSIGNED_INT', ps: 'uvec4', zero: 'uvec4(0u)' },
  2: { glsl: 'ivec', scalar: 'int', pointer: 'INT', ps: 'ivec4', zero: 'ivec4(0)' },
  3: { glsl: 'vec', scalar: 'float', pointer: 'FLOAT', ps: 'vec4', zero: 'vec4(0.0)' },
};
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const element = ([semantic, index, register, systemValue, componentType, start, count, offset], k) =>
  ({ k, semantic, index, register, systemValue, componentType, start, count, offset, attr: `a_t${k}` });

/** 每個頂點都與 SV_POSITION 逐位元相同的 4 分量元素（clip 座標副本）→ 元素序號集合 */
function clipCopies(bytes, g, elements, pos) {
  const n = g.count;
  if (!n) return new Set();
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
  if (g.stride % 4 || bytes.byteLength < n * g.stride) throw new Error(`頂點資料 ${bytes.byteLength} bytes 不足 ${n}×${g.stride}`);
  const s = g.stride >> 2, p = pos.offset >> 2;
  const copies = new Set();
  for (const e of elements) {
    if (e === pos || e.count !== 4 || e.componentType !== 3 || e.offset % 4) continue;
    const o = e.offset >> 2;
    let same = true;
    for (let v = 0; v < n && same; v++) for (let c = 0; c < 4; c++) if (u[v * s + o + c] !== u[v * s + p + c]) { same = false; break; }
    if (same) copies.add(e.k);
  }
  return copies;
}

/** DS 輸出元素 × PS 輸入簽章 → pass-through VS 原始碼（對不上丟錯） */
function vertexSource(elements, pos, copies, ps) {
  const header = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'uniform vec2 xiv_ndc_offset;', 'uniform mat4 xiv_tess_crop;'];
  const body = [];
  for (const e of elements) {
    const t = COMPONENT[e.componentType];
    if (!t) throw new Error(`${e.semantic}${e.index} 分量型別 ${e.componentType} 未支援`);
    if (e.start + e.count > 4 || e.count < 1) throw new Error(`${e.semantic}${e.index} 分量範圍 ${e.start}+${e.count} 不合法`);
    header.push(`in ${e.count === 1 ? t.scalar : t.glsl + e.count} ${e.attr};`);
  }
  // SV_POSITION：左乘裁切 K（D3D clip），再換成 GL（同 dxbc2glsl VS）
  body.push(`  vec4 p = xiv_tess_crop * ${pos.attr};`);
  body.push('  gl_Position = vec4(p.x + xiv_ndc_offset.x * p.w, -p.y + xiv_ndc_offset.y * p.w, p.z * 2.0 - p.w, p.w);');
  const regs = new Map(); // 暫存器 → 元素
  for (const e of elements) if (e !== pos) { if (!regs.has(e.register)) regs.set(e.register, []); regs.get(e.register).push(e); }
  const built = new Set();
  const used = (v) => ps.inputs.find(s => s.register === v.register && s.name.toUpperCase() === v.semantic.toUpperCase() && s.index === v.index)?.used?.trim() ?? '';
  for (const v of ps.varyings) {
    const list = regs.get(v.register) ?? [];
    const match = list.find(e => e.semantic.toUpperCase() === v.semantic.toUpperCase() && e.index === v.index);
    if (!match) throw new Error(`PS 輸入 ${v.semantic}${v.index}（v${v.register}）在 DS 輸出沒有同暫存器同語意的元素`);
    const t = COMPONENT[match.componentType];
    if (t.ps !== v.type) throw new Error(`PS 輸入 ${v.semantic}${v.index} 型別 ${v.type} 與 DS 輸出 ${t.ps} 不符`);
    for (const ch of used(v)) {
      const c = LETTERS.indexOf(ch);
      if (!list.some(e => e.start <= c && c < e.start + e.count && COMPONENT[e.componentType].ps === v.type)) throw new Error(`PS 用到 ${v.semantic}${v.index}.${ch}，DS 沒有輸出該分量`);
    }
    const r = `xiv_r${v.register}`;
    if (!built.has(v.register)) {
      built.add(v.register);
      body.push(`  ${v.type} ${r} = ${t.zero};`);
      for (const e of list) {
        if (COMPONENT[e.componentType].ps !== v.type) continue;
        const dst = LETTERS.slice(e.start, e.start + e.count), src = LETTERS.slice(0, e.count);
        const value = copies.has(e.k) ? `(xiv_tess_crop * ${e.attr})` : e.attr;
        body.push(`  ${r}.${dst} = ${e.count === 1 ? value : `${value}.${src}`};`);
      }
    }
    const flat = (v.interp ?? '').includes('constant') || v.type !== 'vec4' ? 'flat ' : '';
    const centroid = (v.interp ?? '').includes('centroid') ? 'centroid ' : '';
    header.push(`${flat}${centroid}out ${v.type} ${v.name};`);
    body.push(`  ${v.name} = ${r};`);
  }
  return [...header, 'void main() {', ...body, '}'].join('\n');
}

/** 一筆曲面細分繪圖 → { program, geo:{ vao, draw } }（同 frame.js vao() 的回傳）；程式依 PS＋元素＋clip 副本共用，VAO 依 PS＋幾何 */
export async function tessSetup(r, op) {
  const gl = r.gl;
  const g = r.m.geometry[op.geometry];
  if (g.topology !== 4) throw new Error(`輸出圖元拓撲 ${g.topology} 未支援（只支援三角形）`);
  const ps = r.m.shaders[op.ps];
  if (!ps?.varyings || !ps.inputs) throw new Error(`${op.ps} 缺輸入簽章資訊`);
  const elements = g.elements.map(element);
  const positions = elements.filter(e => e.systemValue === POSITION);
  if (positions.length !== 1 || positions[0].count !== 4 || positions[0].componentType !== 3) throw new Error('DS 輸出要有且只有一個 float4 SV_POSITION');
  const pos = positions[0];
  const bytes = await r.bytesOf(g.vb);
  const copies = clipCopies(bytes, g, elements, pos);
  const progKey = `tess|${op.ps}|${JSON.stringify(g.elements)}|${[...copies].join(',')}`;
  r.tessPrograms ??= new Map();
  if (!r.tessPrograms.has(progKey)) {
    const vs = vertexSource(elements, pos, copies, ps);
    const fs = shaderDecoder.decode(await r.bytesOf({ file: ps.file }));
    r.tessPrograms.set(progKey, compileProgram(gl, vs, fs));
    r.noteCompile?.(`tess:${op.ps}|${JSON.stringify(g.elements)}`);
  }
  const program = r.tessPrograms.get(progKey);
  const vaoKey = `${progKey}|${op.geometry}`;
  if (!r.vaos[vaoKey]) {
    gl.bindVertexArray(null);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, Math.max(bytes.byteLength, 16), gl.STATIC_DRAW);
    if (bytes.byteLength) gl.bufferSubData(gl.ARRAY_BUFFER, 0, bytes);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    for (const e of elements) {
      const loc = gl.getAttribLocation(program, e.attr);
      if (loc < 0) continue; // 沒被 PS 用到的元素，編譯器已移除
      gl.enableVertexAttribArray(loc);
      const type = gl[COMPONENT[e.componentType].pointer];
      if (e.componentType === 3) gl.vertexAttribPointer(loc, e.count, type, false, g.stride, e.offset);
      else gl.vertexAttribIPointer(loc, e.count, type, g.stride, e.offset);
    }
    gl.bindVertexArray(null);
    r.vaos[vaoKey] = { vao, draw: { mode: gl.TRIANGLES, first: 0, count: g.count, instances: 1 } };
  }
  return { program, geo: r.vaos[vaoKey] };
}

/** 放大裁切 K（replay.clipCrop，列優先）→ uniform；呼叫時 program 已 useProgram */
export function bindTessCrop(r, program) {
  const loc = r.loc(program, 'xiv_tess_crop');
  if (!loc) return;
  r.gl.uniformMatrix4fv(loc, true, r.clipCrop ? Float32Array.from(r.clipCrop) : IDENTITY);
}
