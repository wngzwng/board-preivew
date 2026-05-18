import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  buildColumnSpec,
  extractLevelStringsFromRows,
  serializeExportCsv,
  APPENDED_EXPORT_COLUMNS,
  INDEX_COLUMN_NAME,
  TAGS_COLUMN_NAME,
  getColumnLabelsFromRows,
  defaultContentColumnIndex,
} from '../src/io/csv.js';
import { operationsToGlyphString } from '../src/board/operationGlyphs.js';

test('parseCsv: 基本逗号与换行', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('parseCsv: 引号内逗号', () => {
  assert.deepEqual(parseCsv('"a,b",c\nx,y'), [
    ['a,b', 'c'],
    ['x', 'y'],
  ]);
});

test('列索引 + 无表头', () => {
  const rows = parseCsv('1,AAA\n2,BBB');
  const spec = buildColumnSpec('1', false);
  assert.deepEqual(extractLevelStringsFromRows(rows, spec), ['AAA', 'BBB']);
});

test('列索引 + 跳过首行表头', () => {
  const rows = parseCsv('id,level\n1,AAA\n2,BBB');
  const spec = buildColumnSpec('1', true);
  assert.deepEqual(extractLevelStringsFromRows(rows, spec), ['AAA', 'BBB']);
});

test('表头列名', () => {
  const rows = parseCsv('Id,Level_Str\n1,AAA\n2,BBB');
  const spec = buildColumnSpec('level_str', false);
  assert.deepEqual(extractLevelStringsFromRows(rows, spec), ['AAA', 'BBB']);
});

test('导出 CSV：保留原始列 + 追加新 4 列（识别到 tags 列时覆盖该列，避免回环导入列重复）', () => {
  const csv = serializeExportCsv({
    header: ['id', 'tags', 'Content'],
    entries: [
      {
        originalRow: ['67024747', 'a|b', '002,20,2,4,4'],
        item: {
          id: '67024747',
          tags: ['a', 'b'],
          sourceLevelStr: '006.26,8.42,6.60,2,4.82',
          levelStr: '002,20,2,4,4.82',
          operations: [
            { type: 'rotate_left', payload: {} },
            { type: 'mirror_x', payload: {} },
          ],
          meta: { hadZAxisOperation: false },
        },
      },
    ],
    operatorOf: operationsToGlyphString,
    tagsColumnIndex: 1,
  });
  assert.ok(csv.startsWith('\uFEFF'));
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], [
    'id',
    'tags',
    'Content',
    ...APPENDED_EXPORT_COLUMNS,
  ]);
  assert.equal(rows[1].length, 3 + APPENDED_EXPORT_COLUMNS.length);
  assert.deepEqual(rows[1].slice(0, 3), ['67024747', 'a|b', '002,20,2,4,4']);
  assert.equal(rows[1][3], '006.26,8.42,6.60,2,4.82');
  assert.equal(rows[1][4], 'LX');
  assert.equal(rows[1][5], '002,20,2,4,4.82');
  assert.equal(rows[1][6], '0');
});

test('导出 CSV：未识别到 tags 列时在原始列后追加 Tags 列', () => {
  const csv = serializeExportCsv({
    header: ['id', 'Content'],
    entries: [
      {
        originalRow: ['1', 'lv'],
        item: {
          id: '1',
          tags: ['easy', 'wip'],
          sourceLevelStr: 'src',
          levelStr: 'tgt',
          operations: [],
          meta: { hadZAxisOperation: false },
        },
      },
    ],
    operatorOf: operationsToGlyphString,
  });
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], [
    'id',
    'Content',
    TAGS_COLUMN_NAME,
    ...APPENDED_EXPORT_COLUMNS,
  ]);
  assert.equal(rows[1][0], '1');
  assert.equal(rows[1][1], 'lv');
  assert.equal(rows[1][2], 'easy|wip');
});

test('导出 CSV：无原始 CSV 时退化为占位列', () => {
  const csv = serializeExportCsv({
    header: null,
    originalColumnCount: 0,
    entries: [
      {
        originalRow: null,
        item: {
          id: 'x',
          tags: [],
          sourceLevelStr: 'src',
          levelStr: 'tgt',
          operations: [{ type: 'flip_z' }],
          meta: { hadZAxisOperation: true },
        },
      },
    ],
    operatorOf: operationsToGlyphString,
  });
  const body = csv.replace(/^\uFEFF/, '');
  const [header, row] = body.split('\r\n');
  assert.equal(header, [TAGS_COLUMN_NAME, ...APPENDED_EXPORT_COLUMNS].join(','));
  assert.equal(row, ',src,Z,tgt,1');
});

test('导出 CSV：可选 Index 列（1 起自增，且在原始列之前）', () => {
  const mkEntry = (id) => ({
    originalRow: [id, 'lv'],
    item: {
      id,
      tags: [],
      sourceLevelStr: 'src',
      levelStr: 'tgt',
      operations: [],
      meta: { hadZAxisOperation: false },
    },
  });
  const csv = serializeExportCsv({
    header: ['id', 'Content'],
    entries: [mkEntry('A'), mkEntry('B'), mkEntry('C')],
    operatorOf: operationsToGlyphString,
    withIndex: true,
  });
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], [
    INDEX_COLUMN_NAME,
    'id',
    'Content',
    TAGS_COLUMN_NAME,
    ...APPENDED_EXPORT_COLUMNS,
  ]);
  assert.deepEqual(
    rows.slice(1).map((r) => r[0]),
    ['1', '2', '3'],
  );
  assert.equal(rows[1][1], 'A');
  assert.equal(rows[3][1], 'C');
});

test('导出 CSV：indexStart 可自定义起点', () => {
  const csv = serializeExportCsv({
    header: null,
    originalColumnCount: 0,
    entries: [
      {
        originalRow: null,
        item: {
          id: 'x',
          tags: [],
          sourceLevelStr: '',
          levelStr: '',
          operations: [],
          meta: { hadZAxisOperation: false },
        },
      },
    ],
    operatorOf: operationsToGlyphString,
    withIndex: true,
    indexStart: 100,
  });
  const rows = parseCsv(csv);
  assert.equal(rows[0][0], INDEX_COLUMN_NAME);
  assert.equal(rows[1][0], '100');
});

test('defaultContentColumnIndex: 默认 Content', () => {
  assert.equal(defaultContentColumnIndex(['Id', 'Content', 'Other']), 1);
  assert.equal(defaultContentColumnIndex(['x', 'y']), 0);
  assert.equal(defaultContentColumnIndex(['CONTENT']), 0);
});

test('getColumnLabelsFromRows: 表头与无表头', () => {
  const rows = parseCsv('A,B,C\n1,2,3');
  assert.deepEqual(getColumnLabelsFromRows(rows, true), ['A', 'B', 'C']);
  assert.deepEqual(getColumnLabelsFromRows(rows, false), ['列 0', '列 1', '列 2']);
});
