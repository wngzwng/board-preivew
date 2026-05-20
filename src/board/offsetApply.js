/**
 * Board Offset 校验 + 应用层。详见 `docs/proposals/board-offset.md` §10.2。
 *
 * 与 `offsetCodec.js` 分层：
 * - `offsetCodec.js` 只做"字符串 ↔ `OffsetRecord[]`"的可逆变换，不依赖 `Tile[]`；
 * - 本模块在 `OffsetRecord[]` 与 `Tile[]` 之间架桥，负责：
 *   1. 校验每条记录的 `(row, col)` 必须命中某块 Tile 的左上角锚点；
 *   2. 校验 `(z, row, col)` 在同一份 offset 列表里唯一；
 *   3. 把记录按"柱子级"展开成 `Map<TileKey, OffsetRecord>`，供渲染层按锚点 O(1) 查询。
 *
 * 错误按 §6 严格抛错策略走，不做静默降级。
 *
 * @typedef {import('../codec/levelCodec.js').Tile} Tile
 * @typedef {import('../codec/offsetCodec.js').OffsetRecord} OffsetRecord
 */

/**
 * 柱子键格式：`"row,col"`；
 * 选 `,` 是因为 row/col 均为 `[0, 61]` 整数，永不出现 `,`，无歧义。
 *
 * @param {number} row
 * @param {number} col
 * @returns {string}
 */
export function towerKey(row, col) {
  return `${row},${col}`;
}

/**
 * 从一组 tiles 中收集所有左上角锚点 `(row, col)`，去重。
 *
 * @param {Tile[]} tiles
 * @returns {Set<string>}
 */
function collectTowerAnchors(tiles) {
  const set = new Set();
  for (const t of tiles) {
    if (!t) continue;
    set.add(towerKey(t.row, t.col));
  }
  return set;
}

/**
 * 把 `OffsetRecord[]` 严格校验并展开为 `Map<TowerKey, OffsetRecord>`。
 *
 * 严格抛错条件：
 * - 任一 `(row, col)` 不属于某块 Tile 的左上角锚点 → `offset 位置不在 board 内: (z, row, col)`
 * - 同一份 records 里出现两次相同 `(z, row, col)` → `offset 位置重复: (z, row, col)`
 *
 * 不抛错的"软约束"（仅在调用方需要 UI 提示时自行处理）：
 * - `z` 是否等于柱子最底层：本模块不强校验。
 *
 * @param {Tile[]} tiles
 * @param {OffsetRecord[]} records
 * @returns {Map<string, OffsetRecord>}
 */
export function applyOffsetsToTiles(tiles, records) {
  /** @type {Map<string, OffsetRecord>} */
  const map = new Map();
  if (!Array.isArray(records) || records.length === 0) return map;
  const anchors = collectTowerAnchors(Array.isArray(tiles) ? tiles : []);
  /** @type {Set<string>} */
  const seen = new Set();
  for (const r of records) {
    const tripleKey = `${r.z},${r.row},${r.col}`;
    if (seen.has(tripleKey)) {
      throw new Error(`offset 位置重复: (${r.z}, ${r.row}, ${r.col})`);
    }
    seen.add(tripleKey);
    const anchor = towerKey(r.row, r.col);
    if (!anchors.has(anchor)) {
      throw new Error(
        `offset 位置不在 board 内: (${r.z}, ${r.row}, ${r.col})`,
      );
    }
    // 一根柱子一条 OffsetRecord（用作该柱子私有的 Z 偏移向量：方向 + 单层增量）。
    // 同一柱子若给出多条不同 z 的记录，取 z 最小那条作为基准层；渲染时按
    // `(tile.z - offRec.z) × dirVec × STEP` 累计偏移，offRec.z 处偏移为 0。
    // 与文档 §7 第 5 条"推荐 z = min(z of tiles at (row, col))"对齐。
    const prev = map.get(anchor);
    if (!prev || r.z < prev.z) {
      map.set(anchor, r);
    }
  }
  return map;
}
