// 跑翻譯後遊戲著色器的 WebGL2 基礎：連結程式、依翻譯資訊綁常數緩衝／貼圖／取樣器、依 mdl 頂點宣告接頂點輸入、上傳 BC 貼圖。
//
// ANGLE D3D11 後端 GPU 行程崩潰（Chrome 預設後端；2026-09-26 查明，見 avoidD3D11SrvOverflow）：
// 觸發＝同一個著色器階段「sampler uniform 數 S」＋「會被 ANGLE 轉成 HLSL StructuredBuffer 的 uniform block 數 B」＞ 16，
// 第一次用該程式繪圖時 GPU 行程 STATUS_ILLEGAL_INSTRUCTION → 整個 context lost（之後連最簡單的 shader 都編不過）。
// ANGLE（src/compiler/translator/tree_ops/hlsl/RecordUniformBlocksWithLargeArrayMember.cpp）把「std140、只有一個成員、
// 該成員是長度 ≥ 50 的一維陣列、只以索引存取」的 block 改成 StructuredBuffer，佔 t 暫存器排在貼圖之後；超過 t15 即崩。
// 證據（RTX 5070 Ti、Chrome --use-angle=d3d11，每次全新 profile）：
//   - 室內包二分：只重播 #645（characterstockings-vs13｜ps2：16 個 sampler＋PS_CB7 uvec4 d[2044]）就崩；PS 換成單色 → 不崩。
//   - 合成著色器（只取樣＋讀 block）：S16+B1(d[50]) 崩、S16+B1(d[49]) 不崩；S15+B1 不崩、S15+B2 崩；S14+B2 不崩、S14+B3 崩；
//     S16＋9 個小 block 不崩。Vulkan 後端同樣內容都不崩。
// 修法：S＋B ＞ 16 時挑最小的 (S＋B−16) 個大陣列 block，把最後一個元素拆成第二個成員（std140 位移與 block 大小完全不變）、
// 存取改走同名 helper → 成員數 ≠ 1，ANGLE 不轉 StructuredBuffer，改用一般 cbuffer（D3D11 本來就容許 4096 vec4 動態索引）。
// 所有後端都套同一份改寫，畫面比對（Vulkan 改前後、Vulkan vs D3D11）見交付紀錄。

/** mdl 頂點宣告 usage → 遊戲輸入語意名（Penumbra MdlFile.VertexUsage；Tangent1 對 BINORMAL）；語意索引＝元素的 usageIndex */
const SEMANTIC = { 0: 'POSITION', 1: 'BLENDWEIGHT', 2: 'BLENDINDICES', 3: 'NORMAL', 4: 'TEXCOORD', 5: 'TANGENT', 6: 'BINORMAL', 7: 'COLOR' };

/** ANGLE D3D11 每個階段可用的貼圖暫存器（D3D11_COMMONSHADER_SAMPLER_SLOT_COUNT；ES 3.00 貼圖與 StructuredBuffer 共用）與轉 StructuredBuffer 的陣列長度門檻 */
const D3D11_T_SLOTS = 16, ANGLE_SB_MIN_ARRAY = 50;

/**
 * 單一階段 GLSL（tools/dxbc2glsl.mjs 產出或手寫）→ 不會讓 ANGLE D3D11 的 t 暫存器超過 16 的等價原始碼（原理見檔頭）。
 * S 以宣告的 sampler 數計（≥ 實際使用數，保守）；B 以「單一成員、長度 ≥ 50 的陣列」block 數計（不看存取方式，保守）。
 * 改寫：`uniform X { T d[N]; } inst;` → `{ T d[N-1]; T d_last; }`，`inst.d[e]` → `inst_d(e)`；有沒改到的 `inst.d` 存取就丟錯（不猜）。
 */
export function avoidD3D11SrvOverflow(src) {
  const samplers = (src.match(/^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?[iu]?sampler\w*\s+\w+\s*;/gm) ?? []).length;
  const blocks = [...src.matchAll(/^(layout\(std140\) uniform \w+ \{ )(\w+) d\[(\d+)\];( \} (\w+);)$/gm)].filter(m => Number(m[3]) >= ANGLE_SB_MIN_ARRAY);
  const over = samplers + blocks.length - D3D11_T_SLOTS;
  if (over <= 0) return src;
  for (const [decl, head, type, size, tail, inst] of blocks.sort((a, b) => a[3] - b[3]).slice(0, over)) {
    const n = Number(size), fn = `${inst}_d`;
    src = src.replace(decl, `${head}${type} d[${n - 1}]; ${type} d_last;${tail}\n` +
      `${type} ${fn}(int i) { return i == ${n - 1} ? ${inst}.d_last : ${inst}.d[i]; }\n` +
      `${type} ${fn}(uint i) { return ${fn}(int(i)); }`);
    const helperTail = `${fn}(int(i)); }`, helperEnd = src.indexOf(helperTail) + helperTail.length;
    const at = `${inst}.d[`;
    let out = src.slice(0, helperEnd), k = helperEnd;
    for (let p = src.indexOf(at, k); p >= 0; p = src.indexOf(at, k)) {
      let depth = 1, q = p + at.length;
      for (; q < src.length && depth; q++) depth += src[q] === '[' ? 1 : src[q] === ']' ? -1 : 0;
      if (depth) throw new Error(`${inst}.d[ 的索引沒有對應的 ]`);
      out += `${src.slice(k, p)}${fn}(${src.slice(p + at.length, q - 1)})`;
      k = q;
    }
    src = out + src.slice(k);
    if (new RegExp(`\\b${inst}\\.d\\b`).test(src.slice(helperEnd))) throw new Error(`${inst}.d 有非索引存取，無法避開 ANGLE D3D11 StructuredBuffer 轉換`);
  }
  return src;
}

/**
 * 連結程式（兩個階段各自先過 avoidD3D11SrvOverflow）。連結後 detach＋delete 兩個 shader 物件（program 已持有編譯結果）。
 */
export function compileProgram(gl, vertSource, fragSource) {
  const shaders = [];
  const make = (type, src) => {
    const s = gl.createShader(type);
    shaders.push(s);
    gl.shaderSource(s, avoidD3D11SrvOverflow(src));
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  try {
    gl.attachShader(p, make(gl.VERTEX_SHADER, vertSource));
    gl.attachShader(p, make(gl.FRAGMENT_SHADER, fragSource));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  } catch (e) {
    gl.deleteProgram(p);
    throw e;
  } finally {
    for (const s of shaders) { if (gl.getAttachedShaders(p)?.includes(s)) gl.detachShader(p, s); gl.deleteShader(s); }
  }
}

/**
 * 依 mdl 頂點宣告設定頂點屬性。整數語意（BLENDWEIGHT／BLENDINDICES）用 vertexAttribIPointer（著色器端 uvec4）。
 * 型別碼（Lumina VertexType）：2 float3、3 float4、5 UByte4、8 UByte4N、13 Half2、14 Half4、16 UShort2、17 UShort4。
 */
export function bindVertexStreams(gl, program, decl, buffers) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  for (const el of decl) {
    const loc = gl.getAttribLocation(program, `a_${SEMANTIC[el.usage]}${el.usageIndex ?? 0}`);
    if (loc < 0) continue;
    const { buffer, stride } = buffers[el.stream];
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc);
    const integer = el.usage === 1 || el.usage === 2;
    const layout = {
      2: [3, gl.FLOAT, false], 3: [4, gl.FLOAT, false], 5: [4, gl.UNSIGNED_BYTE, false], 8: [4, gl.UNSIGNED_BYTE, true],
      13: [2, gl.HALF_FLOAT, false], 14: [4, gl.HALF_FLOAT, false], 16: [2, gl.UNSIGNED_SHORT, false], 17: [4, gl.UNSIGNED_SHORT, false],
    }[el.type];
    if (!layout) throw new Error(`未支援的頂點型別 ${el.type}`);
    if (integer) gl.vertexAttribIPointer(loc, layout[0], layout[1], stride, el.offset);
    else gl.vertexAttribPointer(loc, layout[0], layout[1], layout[2], stride, el.offset);
  }
  return vao;
}

const BC = {
  BC1: ['WEBGL_compressed_texture_s3tc', 'COMPRESSED_RGBA_S3TC_DXT1_EXT'],
  BC2: ['WEBGL_compressed_texture_s3tc', 'COMPRESSED_RGBA_S3TC_DXT3_EXT'],
  BC3: ['WEBGL_compressed_texture_s3tc', 'COMPRESSED_RGBA_S3TC_DXT5_EXT'],
  BC4: ['EXT_texture_compression_rgtc', 'COMPRESSED_RED_RGTC1_EXT'],
  BC5: ['EXT_texture_compression_rgtc', 'COMPRESSED_RED_GREEN_RGTC2_EXT'],
  BC7: ['EXT_texture_compression_bptc', 'COMPRESSED_RGBA_BPTC_UNORM_EXT'],
};

/** 遊戲 .tex 內容（每個 mip 依序含全部陣列層）→ 2D 或 2D 陣列貼圖 */
export function uploadTexture(gl, { format, arraySize, mips }, data) {
  const [extName, key] = BC[format] ?? [];
  const ext = extName && gl.getExtension(extName);
  if (!ext) throw new Error(`瀏覽器不支援 ${format}`);
  const internal = ext[key];
  const tex = gl.createTexture();
  const array = arraySize > 1;
  const target = array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;
  gl.bindTexture(target, tex);
  mips.forEach((m, level) => {
    const bytes = data.subarray(m.offset, m.offset + m.size);
    if (array) gl.compressedTexImage3D(target, level, internal, m.w, m.h, arraySize, 0, bytes);
    else gl.compressedTexImage2D(target, level, internal, m.w, m.h, 0, bytes);
  });
  gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, mips.length - 1);
  return { tex, target };
}
