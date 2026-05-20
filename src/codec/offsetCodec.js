/**
 * Board Offset 编解码（柱子级视觉偏移），见 `docs/proposals/board-offset.md`。
 *
 * `offset_str` 是零或多个 **4 字符组**的拼接：
 *
 * ```text
 * group = char[z] char[row] char[col] marker_char     # 顺序：层 → 行 → 列 → 标记
 * ```
 *
 * - 前 3 位用项目现有 `charMap` 的 62 进制（`0-9A-Za-z`）。
 * - 第 4 位 `marker` 用**独立**字符表 `A-Xa-x`（0–47），编码 8 个方向 × 6 个档位。
 *
 * 模块只做"字符串 ↔ `OffsetRecord[]`"的可逆变换，不做"位置必须命中 Tile"
 * 之类的语义校验——那部分在 `src/board/offsetApply.js`。
 *
 * 错误统一 `throw new Error(...)`，与 `levelCodec.js` 风格保持一致。
 *
 * @typedef {{
 *   z: number,
 *   row: number,
 *   col: number,
 *   direction: number,
 *   magnitude: number,
 * }} OffsetRecord
 */

import { charToNumber, numberToChar } from './charMap.js';

/** 单字符 marker 校验：仅允许 A-X / a-x。 */
const MARKER_RE = /^[A-Xa-x]$/;

/** 方向数量（与 §4.3 8 方向枚举一致） */
export const OFFSET_DIRECTION_COUNT = 8;

/** 档位数量（每个方向 6 档） */
export const OFFSET_MAGNITUDE_COUNT = 6;

/** marker 数值上界 = 48（独立字符表 A-X + a-x） */
export const OFFSET_MARKER_COUNT =
  OFFSET_DIRECTION_COUNT * OFFSET_MAGNITUDE_COUNT;

/**
 * 档位单位量：`UNIT = 1/100`（棋子宽度的百分比单位）。
 * 第 (magnitude + 1) 档的视觉幅度 = `(magnitude + 1) × UNIT × 棋子宽度`。
 *
 * 单位刻意取得比全局 Z 偏移更细：Z 偏移按棋子宽度的 `%` 走，单位即 `1`；
 * offset 是设计师手工挪 1–6% 用的，因此 UNIT = 0.01。
 */
export const OFFSET_UNIT = 1 / 100;

/**
 * 方向编号 → `(dRow, dCol)` 单位向量。`dRow` 向下为正、`dCol` 向右为正，
 * 与本项目 `Tile.row / col` 同向。
 *
 * @type {Readonly<Array<readonly [number, number]>>}
 */
export const OFFSET_DIRECTION_VECTORS = Object.freeze([
  [-1, 0], // 0 上
  [1, 0], // 1 下
  [0, -1], // 2 左
  [0, 1], // 3 右
  [-1, -1], // 4 左上
  [-1, 1], // 5 右上
  [1, -1], // 6 左下
  [1, 1], // 7 右下
]);

/**
 * marker 字符 → 数值（0–47）。
 *
 * - `A` – `X` ↦ 0 – 23
 * - `a` – `x` ↦ 24 – 47
 *
 * @param {string} ch
 * @returns {number}
 */
export function markerToNumber(ch) {
  if (typeof ch !== 'string' || !MARKER_RE.test(ch)) {
    throw new Error(`非法 marker 字符: ${JSON.stringify(ch)}（合法范围 A-X / a-x）`);
  }
  const code = ch.charCodeAt(0);
  if (ch >= 'A' && ch <= 'X') return code - 'A'.charCodeAt(0);
  return code - 'a'.charCodeAt(0) + 24;
}

/**
 * 数值（0–47）→ marker 字符。
 * @param {number} n
 * @returns {string}
 */
export function numberToMarker(n) {
  if (!Number.isInteger(n) || n < 0 || n >= OFFSET_MARKER_COUNT) {
    throw new Error(`marker 数值越界: ${n}（合法 0–${OFFSET_MARKER_COUNT - 1}）`);
  }
  if (n < 24) return String.fromCharCode('A'.charCodeAt(0) + n);
  return String.fromCharCode('a'.charCodeAt(0) + n - 24);
}

/**
 * 解码 `offset_str` → `OffsetRecord[]`。
 *
 * - 空串 / `null` / `undefined` 返回 `[]`（"无 offset"，合法）；
 * - 长度非 4 倍数立即抛错；
 * - 任一组的 4 字符越界都附 `第 K 组「XXXX」` 前缀，便于 UI 定位。
 *
 * @param {string | null | undefined} offsetStr
 * @returns {OffsetRecord[]}
 */
export function parseOffsetStr(offsetStr) {
  if (offsetStr == null || offsetStr === '') return [];
  if (typeof offsetStr !== 'string') {
    throw new Error(`offset 必须是字符串: ${typeof offsetStr}`);
  }
  if (offsetStr.length % 4 !== 0) {
    throw new Error(`offset 长度不是 4 的倍数: ${JSON.stringify(offsetStr)}`);
  }
  /** @type {OffsetRecord[]} */
  const out = [];
  for (let i = 0; i < offsetStr.length; i += 4) {
    const group = offsetStr.slice(i, i + 4);
    const groupNo = i / 4 + 1;
    let z;
    let row;
    let col;
    try {
      z = charToNumber(group[0]);
      row = charToNumber(group[1]);
      col = charToNumber(group[2]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`offset 第 ${groupNo} 组「${group}」: ${msg}`);
    }
    let n;
    try {
      n = markerToNumber(group[3]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`offset 第 ${groupNo} 组「${group}」: ${msg}`);
    }
    out.push({
      z,
      row,
      col,
      direction: Math.floor(n / OFFSET_MAGNITUDE_COUNT),
      magnitude: n % OFFSET_MAGNITUDE_COUNT,
    });
  }
  return out;
}

/**
 * 编码 `OffsetRecord[]` → `offset_str`。
 *
 * - 空数组 / `null` / `undefined` 返回 `""`。
 * - 字段越界（`z/row/col` 超出 `[0, 61]`、`direction` 超出 `[0, 7]`、
 *   `magnitude` 超出 `[0, 5]`）立即抛错，错误信息带 `第 K 条` 前缀。
 *
 * @param {OffsetRecord[] | null | undefined} records
 * @returns {string}
 */
export function serializeOffsetRecords(records) {
  if (records == null) return '';
  if (!Array.isArray(records)) {
    throw new Error(`offset 序列化输入必须是数组: ${typeof records}`);
  }
  if (records.length === 0) return '';
  const parts = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const recordNo = i + 1;
    if (!r || typeof r !== 'object') {
      throw new Error(`第 ${recordNo} 条 offset 记录不是对象`);
    }
    const dir = r.direction;
    const mag = r.magnitude;
    if (
      !Number.isInteger(dir) ||
      dir < 0 ||
      dir >= OFFSET_DIRECTION_COUNT
    ) {
      throw new Error(
        `第 ${recordNo} 条 direction 越界: ${dir}（合法 0–${OFFSET_DIRECTION_COUNT - 1}）`,
      );
    }
    if (
      !Number.isInteger(mag) ||
      mag < 0 ||
      mag >= OFFSET_MAGNITUDE_COUNT
    ) {
      throw new Error(
        `第 ${recordNo} 条 magnitude 越界: ${mag}（合法 0–${OFFSET_MAGNITUDE_COUNT - 1}）`,
      );
    }
    let zCh;
    let rowCh;
    let colCh;
    try {
      zCh = numberToChar(r.z);
      rowCh = numberToChar(r.row);
      colCh = numberToChar(r.col);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`第 ${recordNo} 条 offset 坐标越界: ${msg}`);
    }
    const markerCh = numberToMarker(dir * OFFSET_MAGNITUDE_COUNT + mag);
    parts.push(zCh + rowCh + colCh + markerCh);
  }
  return parts.join('');
}
