// 著色器包（.shpk）解析：著色器表（各自的常數緩衝／取樣器／貼圖資源表與 DXBC 位置）、材質參數預設值、
// 系統／場景／材質／子視圖 key、節點（每個節點＝一組 key 值，列出各 pass 用的 VS／PS 序號）。
// 格式對照 Penumbra.GameData ShpkFile（Penumbra 1.5.1.26 反組譯）；節點選擇子＝各 key 值以 31 次方加權相加。

const MAGIC = 0x6b506853; // 'ShPk'
const DX11 = 0x31315844;  // 'DX11'

function reader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  return {
    get pos() { return o; },
    u16() { const v = dv.getUint16(o, true); o += 2; return v; },
    u32() { const v = dv.getUint32(o, true); o += 4; return v; },
    bytes(n) { const v = bytes.subarray(o, o + n); o += n; return v; },
    u32s(n) { const v = []; for (let i = 0; i < n; i++) v.push(this.u32()); return v; },
  };
}

export function parseShpk(bytes) {
  const r = reader(bytes);
  if (r.u32() !== MAGIC) throw new Error('不是 shpk');
  const version = r.u32();
  if (r.u32() !== DX11) throw new Error('只支援 DX11 shpk');
  if (r.u32() !== bytes.length) throw new Error('shpk 長度不符');
  const blobsOffset = r.u32(), stringsOffset = r.u32();
  const vsCount = r.u32(), psCount = r.u32();
  const materialParamsSize = r.u32();
  const materialParamCount = r.u16();
  const hasDefaults = r.u16() !== 0;
  const constantCount = r.u32();
  const samplerCount = r.u16(), textureCount = r.u16();
  const uavCount = r.u32(), systemKeyCount = r.u32(), sceneKeyCount = r.u32(), materialKeyCount = r.u32();
  const nodeCount = r.u32(), aliasCount = r.u32();
  const v131 = version >= 0xD01;
  if (v131) r.u32s(3);
  const decoder = new TextDecoder();
  const str = (offset, length) => decoder.decode(bytes.subarray(stringsOffset + offset, stringsOffset + offset + length));
  const resources = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const id = r.u32(), offset = r.u32(), length = r.u16();
      out.push({ id, name: str(offset, length), isTexture: r.u16(), slot: r.u16(), size: r.u16() });
    }
    return out;
  };
  const shaders = (n, stage) => {
    const out = [];
    const header = stage === 'vs' ? 8 : 0; // DX11 VS 的 blob 前面有 8 bytes 附加表頭
    for (let i = 0; i < n; i++) {
      const start = r.u32(), length = r.u32();
      const nc = r.u16(), ns = r.u16(), nu = r.u16(), nt = r.u16();
      if (v131) r.u32();
      const constants = resources(nc), samplers = resources(ns), uavs = resources(nu), textures = resources(nt);
      out.push({ index: i, stage, constants, samplers, uavs, textures, blob: { offset: blobsOffset + start + header, length: length - header } });
    }
    return out;
  };
  const vertexShaders = shaders(vsCount, 'vs');
  const pixelShaders = shaders(psCount, 'ps');
  const materialParams = [];
  for (let i = 0; i < materialParamCount; i++) materialParams.push({ id: r.u32(), offset: r.u16(), size: r.u16() });
  const materialDefaults = hasDefaults ? bytes.slice(r.pos, r.pos + materialParamsSize) : new Uint8Array(materialParamsSize);
  if (hasDefaults) r.bytes(materialParamsSize);
  const constants = resources(constantCount), samplers = resources(samplerCount), textures = resources(textureCount), uavs = resources(uavCount);
  const keys = (n) => { const out = []; for (let i = 0; i < n; i++) out.push({ id: r.u32(), defaultValue: r.u32() }); return out; };
  const systemKeys = keys(systemKeyCount), sceneKeys = keys(sceneKeyCount), materialKeys = keys(materialKeyCount);
  const subViewKeys = [{ id: 1, defaultValue: r.u32() }, { id: 2, defaultValue: r.u32() }];
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const selector = r.u32(), passCount = r.u32();
    const passIndices = Array.from(r.bytes(16));
    if (v131) r.u32s(2);
    const node = {
      selector, passIndices,
      systemKeys: r.u32s(systemKeyCount), sceneKeys: r.u32s(sceneKeyCount), materialKeys: r.u32s(materialKeyCount), subViewKeys: r.u32s(2),
      passes: [],
    };
    for (let p = 0; p < passCount; p++) {
      node.passes.push({ id: r.u32(), vs: r.u32(), ps: r.u32() });
      if (v131) r.u32s(3);
    }
    nodes.push(node);
  }
  const nodeBySelector = new Map(nodes.map((n, i) => [n.selector, i]));
  for (let i = 0; i < aliasCount; i++) { const s = r.u32(), n = r.u32(); if (!nodeBySelector.has(s)) nodeBySelector.set(s, n); }
  return {
    version, bytes, vertexShaders, pixelShaders, materialParams, materialParamsSize, materialDefaults,
    constants, samplers, textures, uavs, systemKeys, sceneKeys, materialKeys, subViewKeys, nodes, nodeBySelector,
  };
}

/** key 值 → 選擇子：Σ value_i · 31^i（uint32 溢位） */
export function keySelector(values) {
  let s = 0, m = 1;
  for (const v of values) { s = (s + Math.imul(v >>> 0, m)) >>> 0; m = Math.imul(m, 31) >>> 0; }
  return s >>> 0;
}

/** 四組 key 值（各自依 shpk 宣告順序）→ 節點 */
export function selectNode(shpk, systemValues, sceneValues, materialValues, subViewValues) {
  const selector = keySelector([keySelector(systemValues), keySelector(sceneValues), keySelector(materialValues), keySelector(subViewValues)]);
  const i = shpk.nodeBySelector.get(selector);
  return i == null ? null : { index: i, selector, ...shpk.nodes[i] };
}

/** 材質的 shader key（id → value）套上預設值，依 shpk 宣告順序 */
export function materialKeyValues(shpk, mtrlKeys) {
  const byId = new Map(mtrlKeys.map(k => [k.id >>> 0, k.value >>> 0]));
  return shpk.materialKeys.map(k => byId.get(k.id >>> 0) ?? k.defaultValue);
}

/** DXBC 位元組 */
export function shaderBlob(shpk, shader) {
  return shpk.bytes.subarray(shader.blob.offset, shader.blob.offset + shader.blob.length);
}
