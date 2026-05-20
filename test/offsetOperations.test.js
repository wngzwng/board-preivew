import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBoardOperation,
  getFootprintCellBounds,
} from '../src/board/boardOperations.js';
import { applyBoardOperationToOffsets } from '../src/board/offsetOperations.js';
import {
  parseOffsetStr,
  serializeOffsetRecords,
  OFFSET_DIRECTION_VECTORS,
} from '../src/codec/offsetCodec.js';
import { fromLevelStr } from '../src/codec/levelCodec.js';

/**
 * 用 (tiles, offsetStr) 组装一份测试夹具，并以同一 bounds 同步变换二者。
 * @param {string} levelStr
 * @param {string} offsetStr
 */
function fixture(levelStr, offsetStr) {
  const tiles = fromLevelStr(levelStr);
  const records = parseOffsetStr(offsetStr);
  const bounds = getFootprintCellBounds(tiles);
  return { tiles, records, bounds };
}

test('offsetOperations: 空数组直接返回空（不抛、不复制）', () => {
  const out = applyBoardOperationToOffsets(
    [],
    'rotate_left',
    {
      rowMin: 0,
      rowMax: 0,
      colMin: 0,
      colMax: 0,
      zMin: 0,
      zMax: 0,
    },
  );
  assert.deepEqual(out, []);
});

test('offsetOperations: rotate_left 四次回到原状（恒等不变量）', () => {
  const { records, bounds } = fixture('000;100;200;300:cccc', '000X');
  let cur = records;
  let b = bounds;
  for (let i = 0; i < 4; i += 1) {
    cur = applyBoardOperationToOffsets(cur, 'rotate_left', b);
  }
  assert.deepEqual(cur, records);
});

test('offsetOperations: mirror_x ∘ mirror_x = id；mirror_y ∘ mirror_y = id', () => {
  const { records, bounds } = fixture('000;100;200;300:cccc', '000X');
  const mx2 = applyBoardOperationToOffsets(
    applyBoardOperationToOffsets(records, 'mirror_x', bounds),
    'mirror_x',
    bounds,
  );
  assert.deepEqual(mx2, records);
  const my2 = applyBoardOperationToOffsets(
    applyBoardOperationToOffsets(records, 'mirror_y', bounds),
    'mirror_y',
    bounds,
  );
  assert.deepEqual(my2, records);
});

test('offsetOperations: flip_z ∘ flip_z = id（z 反转 + direction 反转两次抵消）', () => {
  const { records, bounds } = fixture('000;100;200;300:cccc', '000X');
  const twice = applyBoardOperationToOffsets(
    applyBoardOperationToOffsets(records, 'flip_z', bounds),
    'flip_z',
    bounds,
  );
  assert.deepEqual(twice, records);
});

test('offsetOperations: rotate_right = rotate_left⁻¹', () => {
  const { records, bounds } = fixture('000;100;200;300:cccc', '000X');
  const lr = applyBoardOperationToOffsets(
    applyBoardOperationToOffsets(records, 'rotate_left', bounds),
    'rotate_right',
    bounds,
  );
  assert.deepEqual(lr, records);
});

test('offsetOperations: rotate_left 同步——offset 锚点跟随 tile 锚点（仍在 board 内）', () => {
  const { tiles, records, bounds } = fixture(
    '000;100;200;300:cccc',
    '000X',
  );
  const tilesAfter = applyBoardOperation(tiles, 'rotate_left');
  const recordsAfter = applyBoardOperationToOffsets(
    records,
    'rotate_left',
    bounds,
  );
  const anchorSet = new Set(tilesAfter.map((t) => `${t.row},${t.col}`));
  for (const r of recordsAfter) {
    assert.ok(
      anchorSet.has(`${r.row},${r.col}`),
      `offset (${r.row},${r.col}) 应仍命中 tile 锚点之一`,
    );
  }
});

test('offsetOperations: rotate_left 方向公式 (dr,dc) → (-dc,dr)', () => {
  const bounds = { rowMin: 0, rowMax: 1, colMin: 0, colMax: 1, zMin: 0, zMax: 0 };
  for (let dir = 0; dir < 8; dir += 1) {
    const out = applyBoardOperationToOffsets(
      [{ z: 0, row: 0, col: 0, direction: dir, magnitude: 0 }],
      'rotate_left',
      bounds,
    );
    const [dr, dc] = OFFSET_DIRECTION_VECTORS[dir];
    const expected = OFFSET_DIRECTION_VECTORS.findIndex(
      ([r, c]) => r === -dc && c === dr,
    );
    assert.equal(out[0].direction, expected, `dir=${dir}`);
  }
});

test('offsetOperations: flip_z 反转方向（视觉效果不变验证）', () => {
  const bounds = { rowMin: 0, rowMax: 1, colMin: 0, colMax: 1, zMin: 0, zMax: 3 };
  // 原: 基准 z=0、方向"左"(2)、档位 5
  const input = [{ z: 0, row: 0, col: 0, direction: 2, magnitude: 5 }];
  const out = applyBoardOperationToOffsets(input, 'flip_z', bounds);
  assert.equal(out[0].z, 3, 'z = zMin+zMax-z = 0+3-0 = 3');
  assert.equal(out[0].direction, 3, '方向"左"反转为"右"');
  assert.equal(out[0].magnitude, 5, 'magnitude 不变');
  // 渲染等价性：对任意 t.z ∈ [0,3]，反转前后视觉偏移相同
  // 反转前 t.z=0:(0-0)×left = 0；t.z=3:(3-0)×left = -3 step（向左 3）
  // 反转后 t'.z=3:(3-3)×right = 0；t'.z=0:(0-3)×right = -3 step（向左 3）✓
  for (let z = 0; z <= 3; z += 1) {
    const zPrime = 3 - z;
    // 加 0 把 -0 强制规范化为 +0，避免 strict assert 的 Object.is 假阴性
    const before = 0 + (z - 0) * OFFSET_DIRECTION_VECTORS[2][1];
    const after = 0 + (zPrime - 3) * OFFSET_DIRECTION_VECTORS[3][1];
    assert.equal(after, before, `z=${z}: before=${before} after=${after}`);
  }
});

test('offsetOperations: 真实样本 fixture 解析→变换→序列化 全链路通畅', () => {
  // 来自 docs/proposals/board-offset.md §5 完整解析示例
  const source = '082N086T042N046T000N008T';
  const { records, bounds } = fixture(
    '082;086;042;046;000;008:cccccc',
    source,
  );
  for (const op of ['rotate_left', 'rotate_right', 'mirror_x', 'mirror_y', 'flip_z']) {
    const out = applyBoardOperationToOffsets(records, op, bounds);
    assert.equal(out.length, records.length, `${op} 不应丢失记录`);
    const str = serializeOffsetRecords(out);
    assert.equal(str.length % 4, 0, `${op} 输出长度应为 4 的倍数`);
    const reparsed = parseOffsetStr(str);
    assert.deepEqual(reparsed, out, `${op} 序列化↔解析必须可逆`);
  }
});

test('offsetOperations: rotate_left 与 mirror_x 不可交换（防 regressed 假设）', () => {
  const { records, bounds } = fixture('000;100;200;300:cccc', '000X');
  const lx = applyBoardOperationToOffsets(
    applyBoardOperationToOffsets(records, 'rotate_left', bounds),
    'mirror_x',
    bounds,
  );
  const xl = applyBoardOperationToOffsets(
    applyBoardOperationToOffsets(records, 'mirror_x', bounds),
    'rotate_left',
    bounds,
  );
  assert.notDeepEqual(lx, xl, '旋转与镜像不交换');
});
