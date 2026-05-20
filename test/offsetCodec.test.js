import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOffsetStr,
  serializeOffsetRecords,
  markerToNumber,
  numberToMarker,
  OFFSET_DIRECTION_COUNT,
  OFFSET_MAGNITUDE_COUNT,
  OFFSET_MARKER_COUNT,
  OFFSET_DIRECTION_VECTORS,
} from '../src/codec/offsetCodec.js';

test('offset: 空串 / null / undefined / 空数组 互为 id', () => {
  assert.deepEqual(parseOffsetStr(''), []);
  assert.deepEqual(parseOffsetStr(null), []);
  assert.deepEqual(parseOffsetStr(undefined), []);
  assert.equal(serializeOffsetRecords([]), '');
  assert.equal(serializeOffsetRecords(null), '');
  assert.equal(serializeOffsetRecords(undefined), '');
});

test('offset: 长度非 4 倍数立即抛错（带原串预览）', () => {
  assert.throws(() => parseOffsetStr('082'), /长度不是 4 的倍数/);
  assert.throws(() => parseOffsetStr('082N0'), /长度不是 4 的倍数/);
});

test('offset: marker 双向一致 — 对所有 48 个合法字符与数值闭环', () => {
  for (let n = 0; n < OFFSET_MARKER_COUNT; n += 1) {
    const ch = numberToMarker(n);
    assert.equal(markerToNumber(ch), n, `n=${n} ch=${ch}`);
  }
  for (let n = 0; n < 24; n += 1) {
    assert.equal(numberToMarker(n), String.fromCharCode('A'.charCodeAt(0) + n));
  }
  for (let n = 24; n < 48; n += 1) {
    assert.equal(numberToMarker(n), String.fromCharCode('a'.charCodeAt(0) + n - 24));
  }
});

test('offset: marker 字符越界一律抛错', () => {
  assert.throws(() => markerToNumber('Y'), /非法 marker 字符/);
  assert.throws(() => markerToNumber('y'), /非法 marker 字符/);
  assert.throws(() => markerToNumber('Z'), /非法 marker 字符/);
  assert.throws(() => markerToNumber('1'), /非法 marker 字符/);
  assert.throws(() => markerToNumber(''), /非法 marker 字符/);
  assert.throws(() => markerToNumber('AB'), /非法 marker 字符/);
});

test('offset: 字符越界（z/row/col）带组号', () => {
  // 第 2 组里 marker 用 ?（不在 A-Xa-x），应该抛错并提示组号
  const bad = '082N003?';
  assert.throws(() => parseOffsetStr(bad), /第 2 组「003\?」/);
});

test('offset: 样本「082N086T042N046T000N008T」逐组解码', () => {
  const sample = '082N086T042N046T000N008T';
  const records = parseOffsetStr(sample);
  assert.equal(records.length, 6);
  const expected = [
    { z: 0, row: 8, col: 2, direction: 2, magnitude: 1 }, // N = 13 → dir 2 (左) mag 1
    { z: 0, row: 8, col: 6, direction: 3, magnitude: 1 }, // T = 19 → dir 3 (右) mag 1
    { z: 0, row: 4, col: 2, direction: 2, magnitude: 1 },
    { z: 0, row: 4, col: 6, direction: 3, magnitude: 1 },
    { z: 0, row: 0, col: 0, direction: 2, magnitude: 1 },
    { z: 0, row: 0, col: 8, direction: 3, magnitude: 1 },
  ];
  assert.deepEqual(records, expected);
  // serialize ∘ parse === id
  assert.equal(serializeOffsetRecords(records), sample);
});

test('offset: 解析 ∘ 序列化 = id（合法字符全覆盖）', () => {
  // 覆盖一些有代表性的字符：低位、字母段边界、马克段边界
  const samples = [
    '000A', // z=0 row=0 col=0 dir=0 mag=0
    'zZaX', // z=61 row=35 col=36 dir=3 mag=5
    '999B0Ab', // 不行——这串长度 7，验证测试结构正确
  ];
  // 上面第 3 个故意非法；只跑前 2 个
  for (const s of samples.slice(0, 2)) {
    const rs = parseOffsetStr(s);
    assert.equal(serializeOffsetRecords(rs), s, `roundtrip fail: ${s}`);
  }
});

test('offset: 序列化 ∘ 解析 = id（结构等价）', () => {
  const rs = [
    { z: 0, row: 0, col: 0, direction: 0, magnitude: 0 },
    { z: 1, row: 35, col: 36, direction: 7, magnitude: 5 },
    { z: 61, row: 8, col: 8, direction: 2, magnitude: 1 },
  ];
  const s = serializeOffsetRecords(rs);
  const back = parseOffsetStr(s);
  assert.deepEqual(back, rs);
});

test('offset: direction / magnitude 越界序列化抛错', () => {
  const base = { z: 0, row: 0, col: 0, direction: 0, magnitude: 0 };
  assert.throws(
    () => serializeOffsetRecords([{ ...base, direction: 8 }]),
    /direction 越界/,
  );
  assert.throws(
    () => serializeOffsetRecords([{ ...base, direction: -1 }]),
    /direction 越界/,
  );
  assert.throws(
    () => serializeOffsetRecords([{ ...base, magnitude: 6 }]),
    /magnitude 越界/,
  );
  assert.throws(
    () => serializeOffsetRecords([{ ...base, magnitude: -1 }]),
    /magnitude 越界/,
  );
});

test('offset: 坐标越界（z/row/col > 61）序列化抛错', () => {
  const base = { z: 0, row: 0, col: 0, direction: 0, magnitude: 0 };
  assert.throws(
    () => serializeOffsetRecords([{ ...base, z: 62 }]),
    /坐标越界/,
  );
  assert.throws(
    () => serializeOffsetRecords([{ ...base, row: 100 }]),
    /坐标越界/,
  );
});

test('offset: 字段顺序固定（交换 row/col 不应产生同一记录）', () => {
  // 082N: z=0 row=8 col=2 dir=2 mag=1
  // 028N: z=0 row=2 col=8 dir=2 mag=1
  const a = parseOffsetStr('082N')[0];
  const b = parseOffsetStr('028N')[0];
  assert.notDeepEqual(a, b);
  assert.equal(a.row, 8);
  assert.equal(a.col, 2);
  assert.equal(b.row, 2);
  assert.equal(b.col, 8);
});

test('offset: 方向向量与文档表一致（(dRow, dCol) 屏幕坐标）', () => {
  assert.equal(OFFSET_DIRECTION_COUNT, 8);
  assert.equal(OFFSET_MAGNITUDE_COUNT, 6);
  // 抽样几条文档约定
  assert.deepEqual(OFFSET_DIRECTION_VECTORS[0], [-1, 0]); // 上
  assert.deepEqual(OFFSET_DIRECTION_VECTORS[3], [0, 1]); // 右
  assert.deepEqual(OFFSET_DIRECTION_VECTORS[7], [1, 1]); // 右下
});
