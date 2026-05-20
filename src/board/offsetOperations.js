/**
 * 把 Board 几何操作同步施加到柱子级 OffsetRecord[]。
 *
 * 用户对盘面执行 rotate / mirror / flip_z 时，柱子级 offset 必须与 tile 同步
 * 几何变换——否则 (row, col) 锚点会与变换后的 tile 错位，offset 渲染失效。
 *
 * 与 [`boardOperations.js`](./boardOperations.js) 关注点分离：
 * tile 变换的核心模块只处理 Tile[]；offset 这层逻辑独立在本文件里。
 *
 * **变换规则**（导出回放与渲染端契约）：
 *
 * | 字段 | 平面操作（rotate/mirror）| `flip_z` |
 * | --- | --- | --- |
 * | `(row, col)` | 与 tile 同公式：2×2 占格四角变换后取 min | 不变 |
 * | `direction` | 单位向量随同一平面变换旋转/镜像后查表 | **反向**（详见下文） |
 * | `magnitude` | 不变 | 不变 |
 * | `z` | 不变 | `zMin + zMax - z`（与 tile.z 同公式） |
 *
 * **`flip_z` 为何要反方向 + 同公式翻 z（推导）**：
 *
 * 渲染端公式（每根柱子上的 tile `t`）：
 *
 * ```text
 * tile_offset(t) = (t.z - offRec.z) × dirVec × step
 * ```
 *
 * 反转 z 后每个 `t.z' = zMin + zMax - t.z`。要求 `tile_offset(t)` 视觉**不变**，
 * 即 `tile_offset'(t') == tile_offset(t)`。代入：
 *
 * ```text
 * (zMin + zMax - t.z - offRec'.z) × dir' × step  ==  (t.z - offRec.z) × dir × step
 * ```
 *
 * 取 `dir' = -dir`、`offRec'.z = zMin + zMax - offRec.z`，等式自然成立。
 *
 * 这与 offsetApply.js 的"软约束"兼容：文档 §7 推荐 offRec.z = min(z of tower)，
 * 但本层不强校验——flip_z 后 offRec.z 可能不再等于柱子局部 min(z)，但渲染结果正确。
 *
 * @typedef {import('../codec/offsetCodec.js').OffsetRecord} OffsetRecord
 * @typedef {import('./boardOperations.js').Tile} Tile
 * @typedef {{
 *   rowMin: number, rowMax: number,
 *   colMin: number, colMax: number,
 *   zMin: number, zMax: number,
 * }} FootprintBounds
 */

import {
  OFFSET_DIRECTION_VECTORS,
  OFFSET_DIRECTION_COUNT,
} from '../codec/offsetCodec.js';

/**
 * 8 方向的反向映射（`flip_z` 用）：`dir → dir'`，满足 `dirVec(dir') == -dirVec(dir)`。
 *
 * - 0 上 (-1, 0)  ↔ 1 下 ( 1, 0)
 * - 2 左 (0, -1)  ↔ 3 右 ( 0, 1)
 * - 4 左上(-1,-1) ↔ 7 右下( 1, 1)
 * - 5 右上(-1, 1) ↔ 6 左下( 1,-1)
 */
const OPPOSITE_DIRECTION = Object.freeze([1, 0, 3, 2, 7, 6, 5, 4]);

/**
 * 单位向量 `(dRow, dCol)` → 8 方向枚举的 index；不在枚举内即抛错（视为 bug）。
 *
 * 8 个方向有限且固定，线性扫描即可（O(8)）；上 Map/记忆化反而增加复杂度。
 *
 * @param {number} dRow
 * @param {number} dCol
 * @returns {number}
 */
function vectorToDirection(dRow, dCol) {
  for (let i = 0; i < OFFSET_DIRECTION_COUNT; i++) {
    const [r, c] = OFFSET_DIRECTION_VECTORS[i];
    if (r === dRow && c === dCol) return i;
  }
  throw new Error(`方向向量不在 8 方向枚举内: (${dRow}, ${dCol})`);
}

/**
 * 单格点 (row, col) 按平面操作公式变换。公式与 boardOperations.js 的
 * `transformGridPoint` **保持一字不差**，但内联在此避免依赖该模块的内部函数。
 *
 * @param {number} row
 * @param {number} col
 * @param {'rotate_left'|'rotate_right'|'mirror_x'|'mirror_y'} op
 * @param {FootprintBounds} b
 */
function rotateGridPoint(row, col, op, b) {
  const { rowMin, rowMax, colMin, colMax } = b;
  switch (op) {
    case 'rotate_left':
      return { row: colMax - col + rowMin, col: row - rowMin + colMin };
    case 'rotate_right':
      return { row: col - colMin + rowMin, col: rowMax - row + colMin };
    case 'mirror_x':
      return { row: rowMax + rowMin - row, col };
    case 'mirror_y':
      return { row, col: colMax + colMin - col };
    default:
      throw new Error(`未知平面操作: ${op}`);
  }
}

/**
 * 对单位方向向量施加平面变换（旋转/镜像）。
 *
 * 推导（屏幕坐标 row↓ col→，与本项目所有几何公式同向）：
 *
 * | op | (dr, dc) → ? | 例验（上 → ?） | 例验（左 → ?） |
 * | --- | --- | --- | --- |
 * | `rotate_left`（视觉逆时针 90°）| (-dc,  dr) | (-1,0) → (0,-1) 左 ✓ | (0,-1) → ( 1, 0) 下 ✓ |
 * | `rotate_right`（视觉顺时针 90°）| ( dc, -dr) | (-1,0) → (0, 1) 右 ✓ | (0,-1) → (-1, 0) 上 ✓ |
 * | `mirror_x`（行中心翻 row）| (-dr,  dc) | (-1,0) ↔ ( 1, 0) 下 ✓ | (0,-1) ↔ ( 0,-1) 左 ✓ |
 * | `mirror_y`（列中心翻 col）| ( dr, -dc) | (-1,0) ↔ (-1, 0) 上 ✓ | (0,-1) ↔ ( 0, 1) 右 ✓ |
 *
 * @param {number} direction
 * @param {'rotate_left'|'rotate_right'|'mirror_x'|'mirror_y'} op
 */
function rotateDirection(direction, op) {
  const [dr, dc] = OFFSET_DIRECTION_VECTORS[direction];
  let nr;
  let nc;
  switch (op) {
    case 'rotate_left':
      nr = -dc;
      nc = dr;
      break;
    case 'rotate_right':
      nr = dc;
      nc = -dr;
      break;
    case 'mirror_x':
      nr = -dr;
      nc = dc;
      break;
    case 'mirror_y':
      nr = dr;
      nc = -dc;
      break;
    default:
      throw new Error(`未知平面操作: ${op}`);
  }
  return vectorToDirection(nr, nc);
}

/**
 * 对全体 offset 记录施加几何变换。
 *
 * `bounds` 必须**与同次调用 `applyBoardOperation` 时所用的输入 tiles 的占格闭区间一致**——
 * 即 `getFootprintCellBounds(tilesBefore)`。错位的 bounds 会让 offset 与 tile 不对齐，
 * 调用方有责任保证一致性。
 *
 * 空数组直接返回 `[]`，不变换、不抛错。
 *
 * @param {OffsetRecord[]} records
 * @param {'rotate_left'|'rotate_right'|'mirror_x'|'mirror_y'|'flip_z'} op
 * @param {FootprintBounds} bounds
 * @returns {OffsetRecord[]}
 */
export function applyBoardOperationToOffsets(records, op, bounds) {
  if (!Array.isArray(records) || records.length === 0) return [];
  const next = records.map((r) => ({
    z: r.z,
    row: r.row,
    col: r.col,
    direction: r.direction,
    magnitude: r.magnitude,
  }));
  for (const r of next) {
    if (op === 'flip_z') {
      r.z = bounds.zMin + bounds.zMax - r.z;
      r.direction = OPPOSITE_DIRECTION[r.direction];
      continue;
    }
    let minR = Infinity;
    let minC = Infinity;
    const corners = [
      [r.row, r.col],
      [r.row + 1, r.col],
      [r.row, r.col + 1],
      [r.row + 1, r.col + 1],
    ];
    for (const [cr, cc] of corners) {
      const p = rotateGridPoint(cr, cc, op, bounds);
      if (p.row < minR) minR = p.row;
      if (p.col < minC) minC = p.col;
    }
    r.row = minR;
    r.col = minC;
    r.direction = rotateDirection(r.direction, op);
  }
  next.sort((a, b) => {
    if (a.z !== b.z) return a.z - b.z;
    if (a.row !== b.row) return a.row - b.row;
    return a.col - b.col;
  });
  return next;
}
