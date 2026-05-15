/**
 * Board 几何操作（见 docs/components/board-operations.md）。
 *
 * **坐标约定**：每条记录的 `(x, y)` 为棋子在网格上的**左上角**（行、列）；
 * 棋子占 **2×2** 格，占格为行 `x..x+1`、列 `y..y+1`（同层 `z` 不变）。
 * 对整块棋盘做变换时，先变换四角格点，再取 **min(行)、min(列)** 作为该牌新锚点并写回。
 *
 * @typedef {{ x: number, y: number, z: number, suit: string }} Tile
 */

/** 仅锚点极值（供渲染等；x/y 为左上角） */
export function getBounds(tiles) {
  if (!tiles.length) {
    return {
      xmin: 0,
      xmax: 0,
      ymin: 0,
      ymax: 0,
      zmin: 0,
      zmax: 0,
    };
  }
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  let zmin = Infinity;
  let zmax = -Infinity;
  for (const t of tiles) {
    xmin = Math.min(xmin, t.x);
    xmax = Math.max(xmax, t.x);
    ymin = Math.min(ymin, t.y);
    ymax = Math.max(ymax, t.y);
    zmin = Math.min(zmin, t.z);
    zmax = Math.max(zmax, t.z);
  }
  return { xmin, xmax, ymin, ymax, zmin, zmax };
}

/**
 * 全体棋子占格在行列上的闭区间极值（含 2×2 外沿），用于几何变换参考框。
 * @param {Tile[]} tiles
 */
export function getFootprintCellBounds(tiles) {
  if (!tiles.length) {
    return { xmin: 0, xmax: 0, ymin: 0, ymax: 0, zmin: 0, zmax: 0 };
  }
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  let zmin = Infinity;
  let zmax = -Infinity;
  for (const t of tiles) {
    xmin = Math.min(xmin, t.x, t.x + 1);
    xmax = Math.max(xmax, t.x, t.x + 1);
    ymin = Math.min(ymin, t.y, t.y + 1);
    ymax = Math.max(ymax, t.y, t.y + 1);
    zmin = Math.min(zmin, t.z);
    zmax = Math.max(zmax, t.z);
  }
  return { xmin, xmax, ymin, ymax, zmin, zmax };
}

/** @param {Tile} t */
function cloneTile(t) {
  return { x: t.x, y: t.y, z: t.z, suit: t.suit };
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
  const { xmin, xmax, ymin, ymax, zmin, zmax } = b;
  switch (op) {
    // 屏幕坐标（x↓ 行、y→ 列）下的「视觉左转 = 逆时针 90°」：
    //   右上 → 左上、左上 → 左下、左下 → 右下、右下 → 右上
    //   x' = ymax - y + xmin, y' = x - xmin + ymin
    case 'rotate_left':
      return {
        row: ymax - col + xmin,
        col: row - xmin + ymin,
        z,
      };
    // 屏幕坐标下的「视觉右转 = 顺时针 90°」：
    //   x' = y - ymin + xmin, y' = xmax - x + ymin
    case 'rotate_right':
      return {
        row: col - ymin + xmin,
        col: xmax - row + ymin,
        z,
      };
    case 'mirror_x':
      return { row: xmax + xmin - row, col, z };
    case 'mirror_y':
      return { row, col: ymax + ymin - col, z };
    case 'flip_z':
      return { row, col, z: zmax + zmin - z };
    default:
      throw new Error(`未知操作: ${op}`);
  }
}

/** 单牌 2×2 四角（行、列、层） */
function tileCornerCells(t) {
  return [
    [t.x, t.y, t.z],
    [t.x + 1, t.y, t.z],
    [t.x, t.y + 1, t.z],
    [t.x + 1, t.y + 1, t.z],
  ];
}

/**
 * 对全体棋子施加几何变换，并将结果按 `(z, x, y)` 升序返回，
 * 以满足 `toLevelStr` 编码器对单调顺序的假设（避免「row/列 重复」报错）。
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
      const p = transformGridPoint(t.x, t.y, t.z, op, b);
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
    t.x = minR;
    t.y = minC;
    t.z = newZ;
  }
  next.sort((a, b2) => {
    if (a.z !== b2.z) return a.z - b2.z;
    if (a.x !== b2.x) return a.x - b2.x;
    return a.y - b2.y;
  });
  return next;
}

/** @param {'rotate_left'|'rotate_right'|'mirror_x'|'mirror_y'|'flip_z'} op */
export function isZAxisOperation(op) {
  return op === 'flip_z';
}
