import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOffsetsToTiles, towerKey } from '../src/board/offsetApply.js';
import { parseOffsetStr } from '../src/codec/offsetCodec.js';

const tiles = [
  { row: 0, col: 0, z: 0, suit: 'a' },
  { row: 0, col: 8, z: 0, suit: 'b' },
  { row: 4, col: 2, z: 0, suit: 'c' },
  { row: 4, col: 6, z: 0, suit: 'd' },
  { row: 8, col: 2, z: 0, suit: 'e' },
  { row: 8, col: 6, z: 0, suit: 'f' },
];

test('offsetApply: 空 records 返回空 Map', () => {
  const map = applyOffsetsToTiles(tiles, []);
  assert.equal(map.size, 0);
});

test('offsetApply: 样本「082N086T042N046T000N008T」全部命中现有 tile 锚点', () => {
  const records = parseOffsetStr('082N086T042N046T000N008T');
  const map = applyOffsetsToTiles(tiles, records);
  assert.equal(map.size, 6);
  assert.equal(map.get(towerKey(8, 2)).direction, 2); // 左
  assert.equal(map.get(towerKey(8, 6)).direction, 3); // 右
  assert.equal(map.get(towerKey(0, 0)).magnitude, 1); // 第 2 档
});

test('offsetApply: 位置未命中 Tile → 严格抛错', () => {
  const records = [
    { z: 0, row: 99, col: 0, direction: 0, magnitude: 0 },
  ];
  assert.throws(
    () => applyOffsetsToTiles(tiles, records),
    /offset 位置不在 board 内: \(0, 99, 0\)/,
  );
});

test('offsetApply: 同 (z, row, col) 重复 → 严格抛错', () => {
  const records = [
    { z: 0, row: 0, col: 0, direction: 0, magnitude: 0 },
    { z: 0, row: 0, col: 0, direction: 1, magnitude: 1 },
  ];
  assert.throws(
    () => applyOffsetsToTiles(tiles, records),
    /offset 位置重复: \(0, 0, 0\)/,
  );
});

test('offsetApply: 同柱子不同 z 取 z 最小的那条', () => {
  // tile.row=4 col=2 同柱子的两条不同 z；行为：取 z 最小
  const records = [
    { z: 3, row: 4, col: 2, direction: 1, magnitude: 1 },
    { z: 0, row: 4, col: 2, direction: 7, magnitude: 5 },
  ];
  const map = applyOffsetsToTiles(tiles, records);
  assert.equal(map.size, 1);
  const r = map.get(towerKey(4, 2));
  assert.equal(r.z, 0);
  assert.equal(r.direction, 7);
});

test('offsetApply: towerKey 格式稳定', () => {
  assert.equal(towerKey(0, 0), '0,0');
  assert.equal(towerKey(61, 61), '61,61');
});
