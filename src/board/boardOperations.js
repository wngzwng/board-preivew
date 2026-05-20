/**
 * Board 几何操作（见 docs/components/board-operations.md）。
 *
 * **坐标约定**：每条记录的 `(row, col)` 为棋子在网格上的**左上角**（行、列）；
 * 棋子占 **2×2** 格，占格为行 `row..row+1`、列 `col..col+1`（同层 `z` 不变）。
 * 对整块棋盘做变换时，先变换四角格点，再取 **min(行)、min(列)** 作为该牌新锚点并写回。
 *
 * 操作 `type` 字符串（`mirror_x` / `mirror_y` / ...）保留旧命名以兼容已存档的导出元数据；
 * 内部字段已迁移到 `row / col`，命名上游对照见 `levelCodec.js` 的 Tile typedef。
 *
 * @typedef {{ row: number, col: number, z: number, suit: string }} Tile
 */

/** 仅锚点极值（供渲染等；`row / col` 为左上角） */
export function getBounds(tiles) {
  if (!tiles.length) {
    return {
      rowMin: 0,
      rowMax: 0,
      colMin: 0,
      colMax: 0,
      zMin: 0,
      zMax: 0,
    };
  }
  let rowMin = Infinity;
  let rowMax = -Infinity;
  let colMin = Infinity;
  let colMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const t of tiles) {
    rowMin = Math.min(rowMin, t.row);
    rowMax = Math.max(rowMax, t.row);
    colMin = Math.min(colMin, t.col);
    colMax = Math.max(colMax, t.col);
    zMin = Math.min(zMin, t.z);
    zMax = Math.max(zMax, t.z);
  }
  return { rowMin, rowMax, colMin, colMax, zMin, zMax };
}

/**
 * 全体棋子占格在行列上的闭区间极值（含 2×2 外沿），用于几何变换参考框。
 * @param {Tile[]} tiles
 */
export function getFootprintCellBounds(tiles) {
  if (!tiles.length) {
    return { rowMin: 0, rowMax: 0, colMin: 0, colMax: 0, zMin: 0, zMax: 0 };
  }
  let rowMin = Infinity;
  let rowMax = -Infinity;
  let colMin = Infinity;
  let colMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const t of tiles) {
    rowMin = Math.min(rowMin, t.row, t.row + 1);
    rowMax = Math.max(rowMax, t.row, t.row + 1);
    colMin = Math.min(colMin, t.col, t.col + 1);
    colMax = Math.max(colMax, t.col, t.col + 1);
    zMin = Math.min(zMin, t.z);
    zMax = Math.max(zMax, t.z);
  }
  return { rowMin, rowMax, colMin, colMax, zMin, zMax };
}

/** @param {Tile} t */
function cloneTile(t) {
  return { row: t.row, col: t.col, z: t.z, suit: t.suit };
}

/** @param {Tile[]} tiles */
function cloneAll(tiles) {
  return tiles.map(cloneTile);
}

/**
 * @param {number} row
 * @param {number} col
 * @param {number} z
 * @param {'rotate_left'|'rotate_right'|'mirror_x'|'mirror_y'|'flip_z'} op
 * @param {ReturnType<typeof getFootprintCellBounds>} b
 */
function transformGridPoint(row, col, z, op, b) {
  const { rowMin, rowMax, colMin, colMax, zMin, zMax } = b;
  switch (op) {
    // 屏幕坐标（row↓ 行、col→ 列）下的「视觉左转 = 逆时针 90°」：
    //   右上 → 左上、左上 → 左下、左下 → 右下、右下 → 右上
    //   row' = colMax - col + rowMin, col' = row - rowMin + colMin
    case 'rotate_left':
      return {
        row: colMax - col + rowMin,
        col: row - rowMin + colMin,
        z,
      };
    // 屏幕坐标下的「视觉右转 = 顺时针 90°」：
    //   row' = col - colMin + rowMin, col' = rowMax - row + colMin
    case 'rotate_right':
      return {
        row: col - colMin + rowMin,
        col: rowMax - row + colMin,
        z,
      };
    // 历史命名 `mirror_x` 保留：语义为「关于行方向（水平）中心线对称」，即 row 翻转
    case 'mirror_x':
      return { row: rowMax + rowMin - row, col, z };
    // 历史命名 `mirror_y` 保留：语义为「关于列方向（垂直）中心线对称」，即 col 翻转
    case 'mirror_y':
      return { row, col: colMax + colMin - col, z };
    case 'flip_z':
      return { row, col, z: zMax + zMin - z };
    default:
      throw new Error(`未知操作: ${op}`);
  }
}

/** 单牌 2×2 四角（行、列、层） */
function tileCornerCells(t) {
  return [
    [t.row, t.col, t.z],
    [t.row + 1, t.col, t.z],
    [t.row, t.col + 1, t.z],
    [t.row + 1, t.col + 1, t.z],
  ];
}

/**
 * 对全体棋子施加几何变换，并将结果按 `(z, row, col)` 升序返回，
 * 以满足 `toLevelStr` 编码器对单调顺序的假设（避免「row/col 重复」报错）。
 *
 * @param {Tile[]} tiles
 * @param {'rotate_left'|'rotate_right'|'mirror_x'|'mirror_y'|'flip_z'} op
 * @returns {Tile[]}
 */
export function applyBoardOperation(tiles, op) {
  const next = cloneAll(tiles);
  const b = getFootprintCellBounds(next);

  for (const t of next) {
    if (op === 'flip_z') {
      const p = transformGridPoint(t.row, t.col, t.z, op, b);
      t.z = p.z;
      continue;
    }
    let minR = Infinity;
    let minC = Infinity;
    let newZ = t.z;
    for (const [r, c, z] of tileCornerCells(t)) {
      const p = transformGridPoint(r, c, z, op, b);
      minR = Math.min(minR, p.row);
      minC = Math.min(minC, p.col);
      newZ = p.z;
    }
    t.row = minR;
    t.col = minC;
    t.z = newZ;
  }
  next.sort((a, b2) => {
    if (a.z !== b2.z) return a.z - b2.z;
    if (a.row !== b2.row) return a.row - b2.row;
    return a.col - b2.col;
  });
  return next;
}

/** @param {'rotate_left'|'rotate_right'|'mirror_x'|'mirror_y'|'flip_z'} op */
export function isZAxisOperation(op) {
  return op === 'flip_z';
}
