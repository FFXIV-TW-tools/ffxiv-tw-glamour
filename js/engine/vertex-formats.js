// 開發用（重播・背景繪圖）：D3D11 input layout 元素的 DXGI 格式 → WebGL2 頂點屬性（建置端檢查、網頁端設定共用）。
// integer＝著色器以整數讀（*_UINT／*_SINT：vertexAttribIPointer）；其餘以浮點讀（UNORM／SNORM 正規化）。
// B8G8R8A8 系列 WebGL 無法換序讀，不列（建置端遇到就跳過該筆繪圖並回報）。
export const VERTEX_FORMATS = {
  2: { size: 4, type: 'FLOAT', bytes: 16 }, 6: { size: 3, type: 'FLOAT', bytes: 12 }, 16: { size: 2, type: 'FLOAT', bytes: 8 }, 41: { size: 1, type: 'FLOAT', bytes: 4 },
  3: { size: 4, type: 'UNSIGNED_INT', bytes: 16, integer: true }, 7: { size: 3, type: 'UNSIGNED_INT', bytes: 12, integer: true }, 17: { size: 2, type: 'UNSIGNED_INT', bytes: 8, integer: true }, 42: { size: 1, type: 'UNSIGNED_INT', bytes: 4, integer: true },
  10: { size: 4, type: 'HALF_FLOAT', bytes: 8 }, 34: { size: 2, type: 'HALF_FLOAT', bytes: 4 }, 54: { size: 1, type: 'HALF_FLOAT', bytes: 2 },
  11: { size: 4, type: 'UNSIGNED_SHORT', bytes: 8, normalized: true }, 12: { size: 4, type: 'UNSIGNED_SHORT', bytes: 8, integer: true },
  13: { size: 4, type: 'SHORT', bytes: 8, normalized: true }, 14: { size: 4, type: 'SHORT', bytes: 8, integer: true },
  35: { size: 2, type: 'UNSIGNED_SHORT', bytes: 4, normalized: true }, 36: { size: 2, type: 'UNSIGNED_SHORT', bytes: 4, integer: true },
  37: { size: 2, type: 'SHORT', bytes: 4, normalized: true }, 38: { size: 2, type: 'SHORT', bytes: 4, integer: true },
  28: { size: 4, type: 'UNSIGNED_BYTE', bytes: 4, normalized: true }, 30: { size: 4, type: 'UNSIGNED_BYTE', bytes: 4, integer: true },
  31: { size: 4, type: 'BYTE', bytes: 4, normalized: true }, 32: { size: 4, type: 'BYTE', bytes: 4, integer: true },
  24: { size: 4, type: 'UNSIGNED_INT_2_10_10_10_REV', bytes: 4, normalized: true },
  57: { size: 1, type: 'UNSIGNED_SHORT', bytes: 2, integer: true }, 62: { size: 1, type: 'UNSIGNED_BYTE', bytes: 1, integer: true },
};

/** input layout 元素 [semantic, semIndex, dxgiFormat, inputSlot, alignedByteOffset, slotClass, stepRate] → 補上 append 位移（0xFFFFFFFF＝接在同槽前一個元素之後） */
export function resolveLayout(elements) {
  const next = {};
  return elements.map(([semantic, index, fmt, slot, offset, slotClass, step]) => {
    const f = VERTEX_FORMATS[fmt];
    const at = offset === 0xFFFFFFFF || offset === -1 ? (next[slot] ?? 0) : offset;
    next[slot] = at + (f?.bytes ?? 0);
    return { name: `a_${semantic}${index}`, semantic, index, fmt, slot, offset: at, instance: slotClass === 1, step };
  });
}
