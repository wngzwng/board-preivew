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
  OFFSET_COLUMN_NAME,
  getColumnLabelsFromRows,
  defaultContentColumnIndex,
  defaultTagsColumnIndex,
  defaultOffsetColumnIndex,
  createCsvStreamParser,
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

test('导出 CSV：识别到 tags 列时覆盖该列（默认追加 Offset 主列在 Tags 之后）', () => {
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
          sourceOffsetStr: '',
          offsetStr: '',
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
    OFFSET_COLUMN_NAME,
    ...APPENDED_EXPORT_COLUMNS,
  ]);
  // 原始 3 列 + 追加 Offset 主列 + 6 个元数据列 = 10
  assert.equal(rows[1].length, 3 + 1 + APPENDED_EXPORT_COLUMNS.length);
  assert.deepEqual(rows[1].slice(0, 3), ['67024747', 'a|b', '002,20,2,4,4']);
  // Offset 主列（空 → ''）
  assert.equal(rows[1][3], '');
  // 元数据：sourceLevel, sourceOffset, operator, targetLevel, targetOffset, HasZOperator
  assert.equal(rows[1][4], '006.26,8.42,6.60,2,4.82');
  assert.equal(rows[1][5], ''); // sourceOffset
  assert.equal(rows[1][6], 'LX'); // operator
  assert.equal(rows[1][7], '002,20,2,4,4.82'); // targetLevel
  assert.equal(rows[1][8], ''); // targetOffset
  assert.equal(rows[1][9], '0'); // HasZOperator
});

test('导出 CSV：未识别到 tags/offset 列时在原始列后追加 Tags + Offset 主列', () => {
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
          sourceOffsetStr: '000A',
          offsetStr: '001B',
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
    OFFSET_COLUMN_NAME,
    ...APPENDED_EXPORT_COLUMNS,
  ]);
  assert.equal(rows[1][0], '1');
  assert.equal(rows[1][1], 'lv');
  assert.equal(rows[1][2], 'easy|wip'); // Tags 主列
  assert.equal(rows[1][3], '001B'); // Offset 主列（= offsetStr）
  assert.equal(rows[1][4], 'src'); // sourceLevel
  assert.equal(rows[1][5], '000A'); // sourceOffset
  assert.equal(rows[1][7], 'tgt'); // targetLevel
  assert.equal(rows[1][8], '001B'); // targetOffset = offsetStr
});

test('导出 CSV：识别到 offset 列时覆盖（与 Tags 同策略）', () => {
  const csv = serializeExportCsv({
    header: ['id', 'Offset', 'Content'],
    entries: [
      {
        originalRow: ['1', 'OLD', 'lv'],
        item: {
          id: '1',
          tags: [],
          sourceLevelStr: 'src',
          levelStr: 'tgt',
          sourceOffsetStr: 'OLD',
          offsetStr: 'NEW',
          operations: [],
          meta: { hadZAxisOperation: false },
        },
      },
    ],
    operatorOf: operationsToGlyphString,
    offsetColumnIndex: 1,
  });
  const rows = parseCsv(csv);
  // Offset 主列识别 → 覆盖；Tags 未识别 → 追加
  assert.deepEqual(rows[0], [
    'id',
    'Offset',
    'Content',
    TAGS_COLUMN_NAME,
    ...APPENDED_EXPORT_COLUMNS,
  ]);
  assert.equal(rows[1][1], 'NEW'); // 覆盖原 'OLD'
});

test('导出 CSV：无原始 CSV 时退化为占位列（Tags + Offset + 6 元数据）', () => {
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
          sourceOffsetStr: '',
          offsetStr: '',
          operations: [{ type: 'flip_z' }],
          meta: { hadZAxisOperation: true },
        },
      },
    ],
    operatorOf: operationsToGlyphString,
  });
  const body = csv.replace(/^\uFEFF/, '');
  const [header, row] = body.split('\r\n');
  assert.equal(
    header,
    [TAGS_COLUMN_NAME, OFFSET_COLUMN_NAME, ...APPENDED_EXPORT_COLUMNS].join(','),
  );
  // Tags='' | Offset='' | sourceLevel=src | sourceOffset='' | operator=Z | targetLevel=tgt | targetOffset='' | HasZOperator=1
  assert.equal(row, ',,src,,Z,tgt,,1');
});

test('导出 CSV：可选 Index 列（1 起自增，且在原始列之前）', () => {
  const mkEntry = (id) => ({
    originalRow: [id, 'lv'],
    item: {
      id,
      tags: [],
      sourceLevelStr: 'src',
      levelStr: 'tgt',
      sourceOffsetStr: '',
      offsetStr: '',
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
    OFFSET_COLUMN_NAME,
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
          sourceOffsetStr: '',
          offsetStr: '',
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

test('defaultTagsColumnIndex / defaultOffsetColumnIndex: 找到则返回索引，无则 -1', () => {
  assert.equal(defaultTagsColumnIndex(['id', 'Tags', 'Content']), 1);
  assert.equal(defaultTagsColumnIndex(['id', 'Content']), -1);
  assert.equal(defaultOffsetColumnIndex(['id', 'Offset', 'Content']), 1);
  assert.equal(defaultOffsetColumnIndex(['id', 'Content']), -1);
  // 大小写无关
  assert.equal(defaultOffsetColumnIndex(['OFFSET']), 0);
  assert.equal(defaultOffsetColumnIndex(['offset']), 0);
});

test('getColumnLabelsFromRows: 表头与无表头', () => {
  const rows = parseCsv('A,B,C\n1,2,3');
  assert.deepEqual(getColumnLabelsFromRows(rows, true), ['A', 'B', 'C']);
  assert.deepEqual(getColumnLabelsFromRows(rows, false), ['列 0', '列 1', '列 2']);
});

/**
 * 把整段文本切成若干 chunk 后喂给流式解析器，把所有 onRow 收到的行收集起来。
 *
 * @param {string} text
 * @param {number[]} cutPoints 每个元素为 chunk 长度；最后一段为剩余全部
 */
function streamParseAll(text, cutPoints = []) {
  /** @type {string[][]} */
  const rows = [];
  const p = createCsvStreamParser((row) => rows.push(row));
  if (!cutPoints.length) {
    p.feed(text);
    p.end();
    return rows;
  }
  let off = 0;
  for (const len of cutPoints) {
    p.feed(text.slice(off, off + len));
    off += len;
  }
  if (off < text.length) p.feed(text.slice(off));
  p.end();
  return rows;
}

test('createCsvStreamParser: 单 chunk 与 parseCsv 同语义', () => {
  const cases = [
    'a,b\n1,2',
    '"a,b",c\nx,y',
    'a,b\n1,"He said ""hi"""\n',
    'a\r\nb\r\n', // \r\n
    '\n', // 只一个换行：空行被丢弃
    'last-without-newline', // 末尾无换行
    'h1,h2\nv1,"line1\nline2"\nv3,v4', // 字段内含换行
    '', // 空文本
  ];
  for (const csv of cases) {
    const expected = parseCsv(csv);
    const got = streamParseAll(csv);
    assert.deepEqual(got, expected, `mismatch for ${JSON.stringify(csv)}`);
  }
});

test('createCsvStreamParser: 多 chunk 切割不影响结果（包括引号转义、\\r\\n 边界）', () => {
  const csv = 'a,b\n"x,y","p""q"\r\nlast,one';
  const expected = parseCsv(csv);
  // 暴力枚举所有 1/2 字符切割位置，确保跨边界状态保持正确
  for (let i = 0; i < csv.length; i++) {
    const got = streamParseAll(csv, [i, 1]);
    assert.deepEqual(
      got,
      expected,
      `chunk split at ${i} produced wrong rows`,
    );
  }
});

test('createCsvStreamParser: BOM 自动剥离', () => {
  const csv = '\uFEFFa,b\n1,2';
  assert.deepEqual(streamParseAll(csv), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('createCsvStreamParser: 跨 chunk 的 \\r\\n 不产生空行', () => {
  // \r 与 \n 被切到不同 chunk
  const got = streamParseAll('a\r\nb', [2, 1]); // ['a\r', '\n', 'b']
  assert.deepEqual(got, [['a'], ['b']]);
});

test('createCsvStreamParser: 跨 chunk 的 "" 转义保持引号内', () => {
  // 引号内的 "" 转义被切到不同 chunk
  const csv = '"a""b",c';
  // 在第 2 个字符切：chunk1='"a', chunk2='"', chunk3='"b",c'
  const got = streamParseAll(csv, [2, 1]);
  assert.deepEqual(got, [['a"b', 'c']]);
});
