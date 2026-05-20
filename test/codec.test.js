import test from 'node:test';
import assert from 'node:assert/strict';
import { toLevelStr, fromLevelStr } from '../src/codec/levelCodec.js';
import { charToNumber, numberToChar } from '../src/codec/charMap.js';
import { SplitChar } from '../src/config/splitChars.js';
import { applyBoardOperation } from '../src/board/boardOperations.js';

test('char/number: 与 Python common 一致（0-9 A-Z a-z）', () => {
  assert.equal(charToNumber('A'), 10);
  assert.equal(charToNumber('Z'), 35);
  assert.equal(charToNumber('a'), 36);
  assert.equal(charToNumber('z'), 61);
  assert.equal(numberToChar(10), 'A');
  assert.equal(numberToChar(35), 'Z');
  assert.equal(numberToChar(36), 'a');
  assert.equal(numberToChar(61), 'z');
});

test('roundtrip: 单牌无花色', () => {
  const tiles = [{ row: 0, col: 0, z: 0, suit: '' }];
  assert.deepEqual(fromLevelStr(toLevelStr(tiles)), tiles);
});

test('roundtrip: 同层两列', () => {
  const tiles = [
    { row: 0, col: 0, z: 0, suit: '' },
    { row: 0, col: 1, z: 0, suit: '' },
  ];
  assert.deepEqual(fromLevelStr(toLevelStr(tiles)), tiles);
});

test('roundtrip: 带花色', () => {
  const tiles = [
    { row: 0, col: 0, z: 0, suit: 'a' },
    { row: 0, col: 1, z: 0, suit: 'b' },
  ];
  const s = toLevelStr(tiles);
  assert.ok(s.includes(SplitChar.POSITION_SUIT));
  assert.deepEqual(fromLevelStr(s), tiles);
});

test('mirror_x 两次回到原状（语义：关于行方向中心线对称，即翻 row）', () => {
  const tiles = [
    { row: 0, col: 0, z: 0, suit: 'x' },
    { row: 2, col: 1, z: 0, suit: 'y' },
  ];
  const once = applyBoardOperation(tiles, 'mirror_x');
  const twice = applyBoardOperation(once, 'mirror_x');
  assert.deepEqual(twice, tiles);
});

test('2×2 左上角：左旋四次回到原锚点', () => {
  const tiles = [{ row: 1, col: 2, z: 0, suit: 'a' }];
  let t = tiles;
  for (let i = 0; i < 4; i += 1) {
    t = applyBoardOperation(t, 'rotate_left');
  }
  assert.deepEqual(t, tiles);
});

test('rotate_left = 视觉逆时针 90°（屏幕坐标 row↓ col→）', () => {
  const tiles = [
    { row: 0, col: 0, z: 0, suit: 'A' },
    { row: 0, col: 2, z: 0, suit: 'B' },
    { row: 2, col: 0, z: 0, suit: 'C' },
    { row: 2, col: 2, z: 0, suit: 'D' },
  ];
  const r = applyBoardOperation(tiles, 'rotate_left');
  const at = (row, col) =>
    r.find((t) => t.row === row && t.col === col)?.suit;
  assert.equal(at(0, 0), 'B');
  assert.equal(at(0, 2), 'D');
  assert.equal(at(2, 0), 'A');
  assert.equal(at(2, 2), 'C');
});

test('rotate_right = 视觉顺时针 90°', () => {
  const tiles = [
    { row: 0, col: 0, z: 0, suit: 'A' },
    { row: 0, col: 2, z: 0, suit: 'B' },
    { row: 2, col: 0, z: 0, suit: 'C' },
    { row: 2, col: 2, z: 0, suit: 'D' },
  ];
  const r = applyBoardOperation(tiles, 'rotate_right');
  const at = (row, col) =>
    r.find((t) => t.row === row && t.col === col)?.suit;
  assert.equal(at(0, 0), 'C');
  assert.equal(at(0, 2), 'A');
  assert.equal(at(2, 0), 'D');
  assert.equal(at(2, 2), 'B');
});

test('真实关卡左转后可重新编码（操作后按 z,row,col 规整）', () => {
  const s =
    '006.26,8.42,6.60,2,4.82;115.33,7.51,5.73;206.24,8.42,6.60,4.82;' +
    '315.33,7.51,5.73;406.24,8.42,6.60,4.82;515.33,7.51,5.73;' +
    '606.24,8.42,6.60,4.82;715.33,7.51,5.73:' +
    '2PK28FF28P3K8P3QP28P8QPQF2P32FKK38Q83K8KK3F28PK223KFQP3Q3';
  const tiles = fromLevelStr(s);
  const rotated = applyBoardOperation(tiles, 'rotate_left');
  const encoded = toLevelStr(rotated);
  const decoded = fromLevelStr(encoded);
  assert.equal(decoded.length, tiles.length);
});

test('decode 失败: 花色与牌位数不一致', () => {
  const broken = toLevelStr([
    { row: 0, col: 0, z: 0, suit: 'a' },
    { row: 0, col: 1, z: 0, suit: '' },
  ]);
  assert.throws(() => fromLevelStr(broken), /花色长度/);
});
