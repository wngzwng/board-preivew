import { SplitChar } from '../config/splitChars.js';
import { numberToChar } from './charMap.js';

/**
 * @typedef {{ last: number | null, seen: Set<number>, first: boolean }} CoordState
 */

function createState() {
  return { last: null, seen: new Set(), first: true };
}

/**
 * 等价于 `format.py` 中 `PositionDataFormatter`。
 *
 * 字段命名对照：本项目 `row / col` ← `format.py` 的 `x / y`。
 * 输出顺序仍是 `layer → row → column`，与 `format.py` 一致；
 * 状态机要求输入按 `(z, row, col)` 升序——见 `sortTiles`。
 *
 * @param {Array<{ row: number, col: number, z: number }>} dataList
 * @returns {string}
 */
export function formatPositionData(dataList) {
  /** @type {Record<'layer'|'row'|'column', CoordState>} */
  const state = {
    layer: createState(),
    row: createState(),
    column: createState(),
  };

  const separators = {
    layer: SplitChar.LAYER,
    row: SplitChar.ROW,
    column: SplitChar.COLUMN,
  };

  const strList = [];

  for (const data of dataList) {
    processCoordinate('layer', data.z, state, separators, strList);
    processCoordinate('row', data.row, state, separators, strList);
    processCoordinate('column', data.col, state, separators, strList);
  }

  return strList.join('');
}

/**
 * @param {'layer'|'row'|'column'} coordType
 * @param {number} value
 * @param {Record<string, CoordState>} state
 * @param {Record<string, string>} separators
 * @param {string[]} strList
 */
function processCoordinate(coordType, value, state, separators, strList) {
  const coordState = state[coordType];

  if (value === coordState.last) {
    return;
  }

  if (coordState.seen.has(value)) {
    throw new Error(`${coordType}重复: ${value}`);
  }

  if (!coordState.first) {
    strList.push(separators[coordType]);
  } else {
    coordState.first = false;
  }

  coordState.seen.add(value);
  coordState.last = value;
  strList.push(numberToChar(value));

  resetSubordinateStates(coordType, state);
}

/**
 * @param {'layer'|'row'|'column'} coordType
 * @param {Record<string, CoordState>} state
 */
function resetSubordinateStates(coordType, state) {
  if (coordType === 'layer') {
    state.row = createState();
    state.column = createState();
  } else if (coordType === 'row') {
    state.column = createState();
  }
}
