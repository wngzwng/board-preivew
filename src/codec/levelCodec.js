import { SplitChar } from '../config/splitChars.js';
import { charToNumber } from './charMap.js';
import { formatPositionData } from './positionFormatter.js';

/**
 * @typedef {{ x: number, y: number, z: number, suit: string }} Tile
 */

/**
 * 仅分割第一段「位置 + 花色」边界（避免花色段含分隔符时歧义）。
 * @param {string} levelStr
 * @returns {{ positionData: string, suitData: string }}
 */
export function splitPositionAndSuit(levelStr) {
  const sep = SplitChar.POSITION_SUIT;
  const i = levelStr.indexOf(sep);
  if (i === -1) {
    return { positionData: levelStr, suitData: '' };
  }
  return {
    positionData: levelStr.slice(0, i),
    suitData: levelStr.slice(i + sep.length),
  };
}

/**
 * @param {string} positionData
 * @returns {Generator<[number, number, number]>}
 */
export function* iterPosFromPositionData(positionData) {
  const layerParts = positionData.split(SplitChar.LAYER);
  for (const layerData of layerParts) {
    if (!layerData.length) continue;
    const layerNum = charToNumber(layerData[0]);
    const rowParts = layerData.slice(1).split(SplitChar.ROW);
    for (const rowData of rowParts) {
      if (!rowData.length) continue;
      const rowNum = charToNumber(rowData[0]);
      const colParts = rowData.slice(1).split(SplitChar.COLUMN);
      for (const columnData of colParts) {
        if (!columnData.length) continue;
        const columnNum = charToNumber(columnData);
        yield [rowNum, columnNum, layerNum];
      }
    }
  }
}

/**
 * 与 Python 一致：按花色字符串每个字符迭代（单字符 suit）。
 * @param {string} suitData
 * @returns {Generator<string>}
 */
export function* iterSuitFromSuitData(suitData) {
  for (const ch of suitData) {
    yield ch;
  }
}

/**
 * @param {string} levelStr
 * @returns {Tile[]}
 */
export function fromLevelStr(levelStr) {
  const { positionData, suitData } = splitPositionAndSuit(levelStr);
  const positions = [...iterPosFromPositionData(positionData)];
  if (!suitData) {
    return positions.map(([x, y, z]) => ({ x, y, z, suit: '' }));
  }
  const suits = [...iterSuitFromSuitData(suitData)];
  if (suits.length !== positions.length) {
    throw new Error(
      `花色长度(${suits.length})与牌位数量(${positions.length})不一致`,
    );
  }
  return positions.map(([x, y, z], i) => ({
    x,
    y,
    z,
    suit: suits[i],
  }));
}

/**
 * @param {Tile[]} dataList
 * @returns {string}
 */
export function toLevelStr(dataList) {
  const hasSuit = dataList.some((d) => d.suit);
  const positionStr = formatPositionData(dataList);
  if (hasSuit) {
    const suitStr = dataList.map((d) => d.suit).join('');
    return `${positionStr}${SplitChar.POSITION_SUIT}${suitStr}`;
  }
  return positionStr;
}

/**
 * @param {Tile[]} dataList
 * @returns {Tile[]}
 */
export function sortTiles(dataList) {
  return [...dataList].sort((a, b) => {
    if (a.z !== b.z) return a.z - b.z;
    if (a.x !== b.x) return a.x - b.x;
    return a.y - b.y;
  });
}
