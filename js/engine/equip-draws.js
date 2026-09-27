// 從玩家的模型、材質與貼圖建立可重播的幾何、著色器綁定與繪圖操作。
import { parseMdl } from '../game/mdl.js';
import { parseMtrl } from '../game/mtrl.js';
import { parseTex } from '../game/tex.js';
import { selectNode, materialKeyValues } from '../game/shpk.js';
import { racialDeformer, mul34, modelScale } from '../game/pbd.js';
import { resolveGear, imcEntry, imcPath, materialPaths, attributeVisible } from '../game/paths.js';
import { parseSklb } from '../game/sklb.js';
import { EST_PATHS, parseEst, extraSkeletonPath, rigidExtraJoints } from '../game/est.js';
import { extendBounds, emptyBounds } from '../game/race.js';
import { uploadTexture } from '../game/xivgl/pass.js';
import { createTexture } from './textures.js';
import { SLOT_CODE, EST_KIND, PART_NAME, SLOT_ORDER, ADDRESS, IDENTITY } from './equip-slots.js';

export class EquipDraws {
  async build(slot, item) {
    const w = { gen: ++this.generation, files: [], geometries: [], tables: [], notes: [], warnings: [], bounds: emptyBounds(), preset: !!item.preset, body: !!this.body };
    try {
      return Object.assign(w, await this.buildInto(w, slot, item));
    } catch (e) {
      this.dispose(w);
      throw e;
    }
  }

  /**
   * item＝裝備 { set, variant, blocks?, preset? }，或外貌部位／身體零件 { path, code, estSet?, shapes?, features?, decal?, body? }
   * （頭髮／臉／尾巴／耳朵／身體零件：沒有 IMC，材質固定 v0001；estSet＝髮型／臉型 id）。骨架、種族一律照 this.skel。
   */
  async buildInto(w, slot, item) {
    const report = [];
    const skel = this.skel;
    const human = !!item.path;
    const found = human ? { path: item.path, code: item.code } : resolveGear((p) => this.packs.chara.has(p), item.set, SLOT_CODE[slot], skel.code);
    if (!found) throw new Error(`${slot}：找不到 ${item.set} 號裝備的模型`);
    const imc = human ? { materialId: 1, attributeMask: 0x3ff } : imcEntry(await this.packs.chara.read(imcPath(item.set, SLOT_CODE[slot])), item.variant, SLOT_CODE[slot]);
    const mdl = parseMdl(await this.read(found.path));
    const D = racialDeformer(this.pbd, skel.code, found.code);
    const scale = modelScale(this.pbd, skel.code, found.code);
    const extra = await this.extraBones(slot, human ? item.estSet : item.set, found.code);
    const extraUsed = new Set();
    w.decal = item.decal ?? null; // 臉彩貼花（makeOp 換 g_SamplerDecal）
    report.push(human
      ? `${slot}：${found.path.split('/').pop()}${item.shapes?.length ? `（形態鍵 ${item.shapes.join(' ')}）` : ''}${w.decal ? `（臉彩 ${w.decal.split('/').pop()}）` : ''}`
      : `${slot}：${found.path.split('/').pop()}（模型種族 c${String(found.code).padStart(4, '0')}，材質版本 v${String(imc.materialId).padStart(4, '0')}）`);
    const ops = [];
    const colorsets = {};
    const materials = new Map();
    let seq = 0;
    let missingTemplate = null;
    for (const [mi, mesh] of mdl.meshes.entries()) {
      const kept = mesh.submeshes.filter(s => s.attributes.every(a => attributeVisible(a, imc.attributeMask, skel.tail, item.features ?? 0)));
      if (!kept.length) continue;
      // 形態鍵：把指定索引位置換成模型內附的替代頂點（臉的眉／眼／鼻／顎／嘴、小瞳孔）
      for (const shape of item.shapes ?? []) {
        const pairs = mesh.shapes.get(shape);
        if (pairs) for (let k = 0; k < pairs.length; k += 2) mesh.indices[pairs[k]] = pairs[k + 1];
      }
      const name = mdl.materials[mesh.materialIndex];
      if (!materials.has(name)) materials.set(name, await this.material(name, imc.materialId));
      const mat = materials.get(name);
      const shpk = await this.shpk(mat.pkg);
      const templates = this.templatesFor(slot, mat.pkg);
      if (!templates.length) {
        // 不能猜沒畫過的著色器；同一件的其他已驗證網格仍應顯示，否則連上衣本體也整件消失。
        // 若整件都沒有可重播的網格，仍照原本的檢查拒絕（驗證模式保留原本的部分重建語意）。
        if (!human && !this.body?.partial) missingTemplate ??= new Error(`${slot}：材質 ${name} 用 ${mat.pkg}.shpk，本幀沒有同 shpk 的裝備繪圖可當範本`);
        w.warnings.push(`${PART_NAME[slot] ?? slot}的 ${name.split('/').pop()}（${mat.pkg === 'charactertattoo' ? '臉部特徵' : mat.pkg}）沒畫：擷取的這一幀沒有畫過這種著色器，沒有範本可照`);
        continue;
      }
      const joints = this.joints(mesh.bones ?? [], D, found.code, extra);
      for (const b of joints.extraUsed) extraUsed.add(b);
      if (joints.missing.length) {
        const err = new Error(human
          ? `${PART_NAME[slot]}需要自帶的額外骨頭 ${joints.missing.join('、')}，骨架資料沒有這些骨頭的姿勢，照遊戲擺不出來`
          : `${slot}：骨頭 ${joints.missing.join('、')} 骨架資料沒有姿勢`);
        err.missingBones = joints.missing;
        throw err;
      }
      const geometry = this.geometry(w, slot, mi, mesh, kept);
      extendBounds(w.bounds, mesh, joints.current, this.mainToWorld);
      const table = mat.mtrl.table ? await this.colorset(w, slot, mi, mat, templates) : null;
      if (table) Object.assign(colorsets, table.entry);
      const mk = materialKeyValues(shpk, mat.mtrl.keyList);
      let passes = 0;
      for (const t of templates) {
        const pick = this.pickShaders(shpk, t, mk);
        if (!pick) continue; // 這個材質在這個 pass 沒有繪圖
        ops.push(await this.makeOp({ w, slot, mi, seq: ++seq, t, shpk, pick, geometry, joints, scale, mat, table }));
        passes++;
      }
      report.push(`  網格 ${mi}：${name.split('/').pop()}（${mat.pkg}）${geometry.count / 3} 個三角形、${passes} 個 pass`);
    }
    if (!ops.length && missingTemplate) throw missingTemplate;
    const blocks = (item.blocks ?? []).filter(s => s !== slot);
    if (blocks.length) report.push(`  同時遮住：${blocks.join('、')}`);
    if (extraUsed.size) report.push(`  額外骨架 ${extra.path.split('/').pop()}：${extraUsed.size} 根額外骨用遊戲參考姿勢剛性接在主骨架${slot === 'Hair' ? '（髮尾用遊戲靜止姿勢，遊戲裡會隨物理擺動）' : ''}`);
    for (const n of new Set(w.notes)) report.push(`  ${n}`);
    return { ops, colorsets, blocks, report, warnings: w.warnings };
  }

  /**
   * 同欄同 shpk 的範本優先；沒有就用第一個有同 shpk 的欄。每個（輸出 pass, shpk pass）取一筆：
   * 同一輪輸出裡同一網格可能被畫好幾次、各用 shpk 節點的不同 pass（本幀頭髮在最後的半透明輪畫 3 次）。
   * 身體零件（Body13–15）只用 bodyPlan 核對過的範本（擷取時身體零件畫過的那幾輪）。
   */
  templatesFor(slot, pkg) {
    if (slot.startsWith('Body')) return this.bodyPasses.templates.filter(t => t.shpk === pkg);
    const all = this.templates.filter(t => t.shpk === pkg && t.op);
    const source = all.some(t => t.slot === slot) ? slot : SLOT_ORDER.find(s => all.some(t => t.slot === s));
    const byPass = new Map();
    for (const t of all.filter(t => t.slot === source)) {
      const key = `${t.passKey}|${t.pass}`;
      if (!byPass.has(key)) byPass.set(key, t);
    }
    return [...byPass.values()];
  }

  /** 範本的所有 key 候選都要選到同一組 VS／PS；節點沒有這個 pass → null */
  pickShaders(shpk, t, materialValues) {
    const picks = new Set();
    let result = null;
    for (const c of t.combos) {
      const node = selectNode(shpk, c.system, c.scene, materialValues, c.subView);
      const pass = node?.passes.find(p => p.id >>> 0 === t.pass);
      picks.add(pass ? `${pass.vs}/${pass.ps}` : '-');
      result = pass;
    }
    if (picks.size !== 1) throw new Error(`${t.shpk} pass ${t.pass.toString(16)}：本幀沒決定的 key 會影響這個材質的著色器（${[...picks].join('、')}）`);
    if (!result) return null;
    const vs = `${t.shpk}-vs${result.vs}`, ps = `${t.shpk}-ps${result.ps}`;
    for (const n of [vs, ps]) if (!this.m.shaders[n]) throw new Error(`著色器 ${n} 沒有預先翻譯`);
    return { vs, ps, vsIdx: result.vs, psIdx: result.ps };
  }

  /** 別的裝備範本（同欄優先、不含皮膚）的同名常數緩衝檔；借到就記在報告 */
  async borrowCb(name, slot, w) {
    const order = [...this.templates.filter(t => t.slot === slot), ...this.templates.filter(t => t.slot !== slot)].filter(t => t.shpk !== 'skin' && t.op);
    for (const t of order) {
      const s = await this.shpk(t.shpk);
      for (const [stage, idx, cbs] of [['vs', /-vs(\d+)$/.exec(t.op.vs)[1], t.op.vsCbs], ['ps', /-ps(\d+)$/.exec(t.op.ps)[1], t.op.psCbs]]) {
        const sh = (stage === 'vs' ? s.vertexShaders : s.pixelShaders)[Number(idx)];
        const res = sh.constants.find(c => c.name === name);
        const src = res && cbs[res.slot];
        if (src?.file) { w.notes.push(`${name} 借自 ${t.slot} 的 #${t.op.i}（${t.op.ps}）`); return src; }
      }
    }
    return null;
  }

  /** @param code 角色種族（身體皮膚材質用；預設目前的骨架種族） */
  async material(name, materialId, code = this.skel.code) {
    let path = null;
    for (const p of materialPaths(name, materialId, code)) if (this.packs.chara.has(p)) { path = p; break; }
    if (!path) throw new Error(`找不到材質 ${name}`);
    const mtrl = parseMtrl(await this.read(path));
    return { path, mtrl, pkg: mtrl.shader.replace('.shpk', '') };
  }

  /** 網格 → 重播幾何（遊戲原樣頂點串＋屬性篩選後的索引），以虛擬檔名登記 */
  geometry(w, slot, mi, mesh, kept) {
    const key = `eq${w.gen}-${slot}-m${mi}`;
    const indices = new Uint16Array(kept.reduce((n, s) => n + s.count, 0));
    let o = 0;
    for (const s of kept) { indices.set(mesh.indices.subarray(s.start, s.start + s.count), o); o += s.count; }
    const streams = mesh.raw.streams.map((bytes, k) => {
      if (!bytes) return null;
      const file = `eq/${key}-s${k}.bin`;
      this.provide(w, file, bytes);
      return { file, stride: mesh.raw.stride[k] };
    });
    this.provide(w, `eq/${key}-i.bin`, new Uint8Array(indices.buffer));
    this.m.geometry[key] = { kind: 'mesh', decl: mesh.raw.decl, streams, indices: `eq/${key}-i.bin`, count: indices.length };
    w.geometries.push(key);
    return { key, count: indices.length };
  }

  /**
   * 額外骨架（EST）：換上的和骨架資料那隻角色穿的不是同一個 sklb（或骨架資料沒有它的骨頭）→ 額外骨頭（本幀與上一幀）用參考姿勢剛性接主骨架算；
   * 這欄沒有額外骨架、sklb 不在 client、或和骨架資料同一個且骨頭都有姿勢 → null（照舊用骨架資料的骨頭）。
   * 骨架資料＝this.skel（擷取角色，或重建整個角色時的 race-pose／擷取姿勢；source 記那隻角色穿戴的 set）。
   * @param set 裝備 id（頭飾／上衣）或髮型／臉型 id；@param code met/top＝裝備模型實際種族、hair／face＝角色種族
   */
  async extraBones(slot, set, code) {
    const kind = EST_KIND[slot];
    if (!kind || !set) return null;
    const s = this.skel, has = (p) => this.packs.chara.has(p);
    this.est ??= {};
    this.est[kind] ??= parseEst(await this.read(EST_PATHS[kind]));
    const path = extraSkeletonPath(kind, set, code, this.est[kind]);
    if (!path || !has(path)) return null;
    const partial = parseSklb(await this.read(path));
    const base = await this.baseSkeleton(s.code);
    const own = partial.bones.filter(b => !base.s.bones.includes(b));
    // 骨架資料那隻角色穿的額外骨架（頭飾／上衣照裝備、髮型／臉照外貌）
    const human = kind === 'hair' || kind === 'face';
    const srcSet = human ? s.source[kind] : s.source[slot];
    const srcCode = human ? s.code : srcSet && resolveGear(has, srcSet, SLOT_CODE[slot], s.code)?.code;
    const srcPath = srcSet && srcCode ? extraSkeletonPath(kind, srcSet, srcCode, this.est[kind]) : null;
    if (srcPath === path && own.every(b => s.bones[b] && s.bonesPrev[b])) return null;
    const make = (native) => Object.fromEntries(rigidExtraJoints(partial, base.s, base.ref, (b) => native[b]));
    return { path, current: make(s.bones), prev: make(s.bonesPrev) };
  }

  /**
   * 骨架矩陣（本幀與上一幀），依網格骨骼表排：額外骨架（extraBones）的骨＝剛性原生矩陣 · 種族變形；
   * 其餘同種族同骨頭有擷取原值就用原值，否則＝原生矩陣 · 種族變形
   */
  joints(bones, D, race, extra) {
    const missing = [], extraUsed = new Set();
    const pack = (native, captured, rigid) => {
      const f = new Float32Array(bones.length * 12);
      bones.forEach((b, p) => {
        const x = rigid?.[b];
        if (x) { extraUsed.add(b); f.set(mul34(x, D.get(b) ?? IDENTITY), p * 12); return; }
        const exact = captured?.[race]?.[b];
        if (exact) { f.set(exact, p * 12); return; }
        const n = native[b];
        if (!n) { if (!missing.includes(b)) missing.push(b); return; }
        f.set(mul34(Float64Array.from(n), D.get(b) ?? IDENTITY), p * 12);
      });
      return f;
    };
    const s = this.skel;
    return { current: pack(s.bones, s.captured?.current, extra?.current), prev: pack(s.bonesPrev, s.captured?.prev, extra?.prev), missing, extraUsed };
  }

  /** 材質色表 → 可染的 RGBA16F 貼圖（格式同範本那張） */
  async colorset(w, slot, mi, mat, templates) {
    const { table, dyeTable } = mat.mtrl;
    const tShpk = await this.shpk(templates[0].shpk);
    let fmt = null, width = null, height = null;
    for (const t of templates) {
      const tex = tShpk.pixelShaders[Number(/-ps(\d+)$/.exec(t.op.ps)[1])].textures.find(x => x.name === 'g_SamplerTable');
      const srv = tex && t.op.srvs.find(s => s.slot === tex.slot);
      const r = srv && this.m.resources[srv.res];
      if (r) { fmt = r.fmt; width = r.w; height = r.h; break; }
    }
    if (fmt == null) return null;
    if (table.width !== width || table.height !== height) throw new Error(`${slot}：${mat.path.split('/').pop()} 色表 ${table.width}×${table.height} 與本幀的 ${width}×${height} 不同（舊制色表），測試版未支援`);
    const res = `eqtbl${w.gen}:${slot}:${mi}`;
    this.r.scratch();
    this.r.tex[res] = createTexture(this.r.gl, { w: width, h: height, fmt });
    w.tables.push(res);
    return { res, entry: { [res]: { base: table.data, width, height, dyeTable: dyeTable ? Uint32Array.from(dyeTable) : null, shader: mat.mtrl.shader, equip: slot } } };
  }

  /** 材質貼圖（遊戲 .tex）→ 重播資源 */
  async texture(path) {
    const key = `eqtex:${path}`;
    if (this.r.tex[key]) return key;
    const tex = parseTex(await this.read(path));
    const gl = this.r.gl;
    this.r.scratch();
    if (/^BC/.test(tex.format ?? '')) {
      let offset = 0;
      const mips = tex.mips.map(m => { const d = { w: m.width, h: m.height, offset, size: m.data.length }; offset += m.data.length; return d; });
      const data = new Uint8Array(offset);
      tex.mips.forEach((m, k) => data.set(m.data, mips[k].offset));
      const t = uploadTexture(gl, { format: tex.format, arraySize: tex.arraySize, mips }, data);
      this.r.tex[key] = { ...t, w: tex.width, h: tex.height, layers: tex.arraySize, mips: mips.length, compressed: true };
    } else if (tex.format === 'B8G8R8A8' && tex.arraySize === 1) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, tex.mips.length, gl.RGBA8, tex.width, tex.height);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      tex.mips.forEach((m, level) => {
        const rgba = new Uint8Array(m.data.length);
        for (let k = 0; k < rgba.length; k += 4) { rgba[k] = m.data[k + 2]; rgba[k + 1] = m.data[k + 1]; rgba[k + 2] = m.data[k]; rgba[k + 3] = m.data[k + 3]; }
        gl.texSubImage2D(gl.TEXTURE_2D, level, 0, 0, m.width, m.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      });
      this.r.tex[key] = { tex: t, target: gl.TEXTURE_2D, w: tex.width, h: tex.height, layers: 1, mips: tex.mips.length, compressed: true };
    } else throw new Error(`${path}：貼圖格式 ${tex.format ?? tex.formatId.toString(16)} 測試版未支援`);
    return key;
  }

  /** 由範本繪圖 t 產生新網格的繪圖 */
  async makeOp({ w, slot, mi, seq, t, shpk, pick, geometry, joints, scale, mat, table }) {
    const T = t.op;
    const tVs = shpk.vertexShaders[Number(/-vs(\d+)$/.exec(T.vs)[1])], tPs = shpk.pixelShaders[Number(/-ps(\d+)$/.exec(T.ps)[1])];
    const nVs = shpk.vertexShaders[pick.vsIdx], nPs = shpk.pixelShaders[pick.psIdx];
    const tag = `eq/${w.gen}/${slot}-m${mi}-${seq}`;
    const cbFrom = async (stage, nShader, tShader, tCbs, declared) => {
      const out = {};
      for (const [slotNo, vec4s] of declared) {
        const res = nShader.constants.find(c => c.slot === slotNo);
        if (!res) throw new Error(`${pick[stage]} 常數緩衝槽 ${slotNo} 在 shpk 資源表裡找不到`);
        const size = vec4s * 16;
        let bytes = null;
        if (res.name === 'g_MaterialParameter') bytes = this.materialCb(shpk, mat.mtrl);
        else if (res.name === 'g_JointMatrixArray') bytes = new Uint8Array(joints.current.buffer);
        else if (res.name === 'g_JointMatrixArrayPrev') bytes = new Uint8Array(joints.prev.buffer);
        else {
          const tRes = tShader.constants.find(c => c.name === res.name);
          let src = tRes && tCbs[tRes.slot];
          // 裝飾貼花顏色：範本那個變體沒讀它時，借同欄（沒有就別欄）非皮膚裝備繪圖的同名常數（本幀裝備材質皆為 1,1,1,1；皮膚與臉另有值，不借）
          if (!src && res.name === 'g_DecalColor') src = await this.borrowCb(res.name, slot, w);
          // 建置時由同一幀推算、並在同背景擷取逐值驗證過的常數（equip-mode.mjs derivedCbs，例：g_LightDirection）
          if (!src && this.e.derivedCbs?.[res.name]) {
            const d = this.e.derivedCbs[res.name];
            src = { file: typeof d === 'string' ? d : d.file };
            w.notes.push(`${res.name} 用建置時推算的 ${src.file}`);
          }
          if (!src) throw new Error(`${pick[stage]} 需要 ${res.name}，範本 #${T.i} 沒有`);
          if (res.name !== 'g_ModelParameter') { out[slotNo] = { file: src.file, size }; continue; }
          bytes = (await this.r.cbBytes(src.file, Math.max(size, 16))).slice();
          new DataView(bytes.buffer).setFloat32(0, scale, true);
        }
        const file = `${tag}-${stage}-${res.name}.bin`;
        this.provide(w, file, bytes);
        out[slotNo] = { file, size };
      }
      return out;
    };
    const srvFrom = async (nShader, tShader, tSrvs) => {
      const out = [];
      for (const res of nShader.textures) {
        const sampler = mat.mtrl.samplerList.find(s => s.id >>> 0 === res.id >>> 0);
        let key = null;
        if (sampler?.path) key = await this.texture(sampler.path);
        else if (res.name === 'g_SamplerTable' && table) key = table.res;
        else if (res.name === 'g_SamplerDecal' && w.decal) key = await this.texture(w.decal);
        else if (res.name === 'g_InputConnectionVertex' && w.body) key = this.noConnection();
        if (key) { out.push({ slot: res.slot, res: key, view: null, fmt: null, mip: 0, mips: this.r.tex[key].mips, slice: 0, slices: 1 }); continue; }
        const tRes = tShader.textures.find(x => x.name === res.name);
        const src = tRes && tSrvs.find(s => s.slot === tRes.slot);
        if (src) out.push({ ...src, slot: res.slot });
      }
      return out;
    };
    // 取樣器依名稱對（shpk 取樣器表：新 PS 的槽 → 名稱 → 範本 PS 同名的槽）；材質取樣器照 mtrl 旗標改位址模式。
    // 範本繪圖當下綁著、但它的 PS 沒用到的取樣器槽（前一筆留下的）不複製
    const samplers = {};
    for (const s of nPs.samplers) {
      const tRes = tPs.samplers.find(x => x.name === s.name);
      const state = tRes && T.samplers[tRes.slot];
      if (!state) continue;
      const m = mat.mtrl.samplerList.find(x => x.id >>> 0 === s.id >>> 0);
      samplers[s.slot] = m ? { ...state, address: [ADDRESS[m.flags & 3], ADDRESS[(m.flags >>> 2) & 3], state.address[2]] } : state;
    }
    const slotOf = (sh, name) => sh.constants.find(c => c.name === name)?.slot;
    const vsCbs = await cbFrom('vs', nVs, tVs, T.vsCbs, this.m.shaders[pick.vs].cb);
    const psCbs = await cbFrom('ps', nPs, tPs, T.psCbs, this.m.shaders[pick.ps].cb);
    const inst = (sh, tInst) => (tInst && slotOf(sh, 'g_InstanceParameter') != null ? { slot: slotOf(sh, 'g_InstanceParameter'), headUp: tInst.headUp } : null);
    return {
      op: 'draw', i: T.i + seq / 1000, after: T.i, equip: slot,
      vs: pick.vs, ps: pick.ps, uvMode: null, vsCbs, psCbs,
      srvs: await srvFrom(nPs, tPs, T.srvs), vsSrvs: await srvFrom(nVs, tVs, T.vsSrvs ?? []),
      samplers,
      state: { ...T.state, rasterizer: { ...T.state.rasterizer, cull: mat.mtrl.materialFlags & 1 ? 3 : 1 } },
      viewport: T.viewport, rtvs: T.rtvs, dsv: T.dsv, geometry: geometry.key,
      // 放大用的投影欄位：同名常數緩衝在新著色器的槽（欄位位移是同一個 struct）
      project: (T.project ?? []).map(p => {
        const s = slotOf(p.stage === 'VS' ? nVs : nPs, p.kind === 'camera' ? 'g_CameraParameter' : 'g_LightParam');
        return s == null ? null : { ...p, slot: s };
      }).filter(Boolean),
      rotate: {
        camera: slotOf(nVs, 'g_CameraParameter'), mainToWorld: T.rotate.mainToWorld, viewProj: T.rotate.viewProj,
        joint: slotOf(nVs, 'g_JointMatrixArray'), vsInstance: inst(nVs, T.rotate.vsInstance), psInstance: inst(nPs, T.rotate.psInstance),
      },
    };
  }

  /**
   * 重建整個角色時的 g_InputConnectionVertex：skin VS 以元素 0（xyz 中心、w 半徑²，主畫面視空間）判斷頂點在不在吸附範圍，
   * 在的話吸到後面列的接縫點（距離 < 0.005×縮放）——這些點是遊戲以擷取角色的網格算好的，別的骨架用了會吸錯。
   * 換成只有一個元素、w＝−1：「半徑² ≥ 距離²」恆假，不吸附（skin-vs23 反組譯：ld_structured t0[0]、ge r0.w, dist²）。
   */
  noConnection() {
    const key = 'eq:no-connection';
    this.r.tex[key] ??= this.r.structured(new Uint8Array(Float32Array.from([0, 0, 0, -1]).buffer));
    return key;
  }

  /** g_MaterialParameter：shpk 預設值＋mtrl 常數（本幀 24 組材質×階段逐位元組驗證） */
  materialCb(shpk, mtrl) {
    const out = shpk.materialDefaults.slice();
    for (const [id, bytes] of mtrl.constantBytes) {
      const p = shpk.materialParams.find(x => x.id >>> 0 === id >>> 0);
      if (p) out.set(bytes.subarray(0, Math.min(bytes.length, p.size)), p.offset);
    }
    return out;
  }
}
