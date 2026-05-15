/**
 * CSV 解析与导出（无第三方依赖）。
 * 导入：支持按列索引提取；表头可由 UI 读取后供用户选择列（默认 `Content`）。
 */

import { readTextFileUtf8 } from './bundle.js';

/** 默认关卡串所在列表头名（不区分大小写） */
export const DEFAULT_CONTENT_COLUMN = 'Content';

/**
 * @param {string[][]} rows
 * @returns {number}
 */
export function getMaxColumnCount(rows) {
  let n = 0;
  for (const r of rows) {
    n = Math.max(n, r.length);
  }
  return n;
}

/**
 * 用于下拉框展示的列名：有表头时用首行单元格（空则显示「列i」）；无表头时为「列 0」…
 * @param {string[][]} rows
 * @param {boolean} firstRowIsHeader
 * @returns {string[]}
 */
export function getColumnLabelsFromRows(rows, firstRowIsHeader) {
  const colCount = getMaxColumnCount(rows);
  if (!colCount) {
    return [];
  }
  if (firstRowIsHeader && rows.length) {
    const h0 = rows[0];
    const labels = [];
    for (let i = 0; i < colCount; i++) {
      const t = (h0[i] ?? '').trim();
      labels.push(t || `列${i}`);
    }
    return labels;
  }
  return Array.from({ length: colCount }, (_, i) => `列 ${i}`);
}

/**
 * 匹配 {@link DEFAULT_CONTENT_COLUMN} 的列索引；无匹配则 0。
 * @param {string[]} headerLikeLabels 与列索引对齐、用于匹配的字符串（通常为表头单元格）
 */
export function defaultContentColumnIndex(headerLikeLabels) {
  const want = DEFAULT_CONTENT_COLUMN.toLowerCase();
  const idx = headerLikeLabels.findIndex(
    (l) => l.trim().toLowerCase() === want,
  );
  return idx === -1 ? 0 : idx;
}

/**
 * RFC4180 风格：支持双引号包裹、字段内 `""` 转义。
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const flushRow = () => {
    row.push(field);
    field = '';
    const nonEmpty = row.some((c) => String(c).trim() !== '');
    if (nonEmpty || row.length > 1) {
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      flushRow();
    } else if (c === '\r') {
      flushRow();
      if (text[i + 1] === '\n') {
        i++;
      }
    } else {
      field += c;
    }
  }
  row.push(field);
  const tailNonEmpty = row.some((c) => String(c).trim() !== '');
  if (tailNonEmpty || row.length > 1) {
    rows.push(row);
  }

  return rows;
}

/**
 * @typedef {{ kind: 'index', index: number, skipHeaderRow: boolean }} ColumnSpecIndex
 * @typedef {{ kind: 'header', name: string }} ColumnSpecHeader
 * @typedef {ColumnSpecIndex | ColumnSpecHeader} ColumnSpec
 */

/**
 * @param {string} columnInput 纯数字 → 列索引；否则 → 表头列名（忽略大小写）
 * @param {boolean} skipHeaderForIndex 当为列索引时，是否跳过首行（表头行，不参与数据）
 */
export function buildColumnSpec(columnInput, skipHeaderForIndex) {
  const raw = columnInput.trim();
  if (!raw) {
    throw new Error('请指定内容列：列号（0 起）或表头列名');
  }
  if (/^\d+$/.test(raw)) {
    const index = Number.parseInt(raw, 10);
    if (index < 0) {
      throw new Error('列号不能为负数');
    }
    return /** @type {ColumnSpecIndex} */ ({
      kind: 'index',
      index,
      skipHeaderRow: Boolean(skipHeaderForIndex),
    });
  }
  return /** @type {ColumnSpecHeader} */ ({ kind: 'header', name: raw });
}

/**
 * @param {string[][]} rows
 * @param {ColumnSpec} spec
 * @returns {string[]}
 */
export function extractLevelStringsFromRows(rows, spec) {
  if (!rows.length) {
    return [];
  }

  if (spec.kind === 'header') {
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const want = spec.name.trim().toLowerCase();
    const idx = header.findIndex((h) => h === want);
    if (idx === -1) {
      throw new Error(`未找到表头列「${spec.name}」。现有列：${rows[0].join(', ')}`);
    }
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const cell = (rows[r][idx] ?? '').trim();
      if (cell) {
        out.push(cell);
      }
    }
    return out;
  }

  const start = spec.skipHeaderRow ? 1 : 0;
  const out = [];
  for (let r = start; r < rows.length; r++) {
    const line = rows[r];
    if (line.length <= spec.index) {
      continue;
    }
    const cell = (line[spec.index] ?? '').trim();
    if (cell) {
      out.push(cell);
    }
  }
  return out;
}

/**
 * @param {string} text
 * @param {ColumnSpec} spec
 */
export function extractLevelStringsFromCsvText(text, spec) {
  const rows = parseCsv(text);
  return extractLevelStringsFromRows(rows, spec);
}

/**
 * @param {File} file
 * @param {ColumnSpec} spec
 * @returns {Promise<string[]>}
 */
export async function readLevelStringsFromCsvFile(file, spec) {
  const text = await readTextFileUtf8(file);
  return extractLevelStringsFromCsvText(text, spec);
}

/** @param {string} s */
function escapeCsvField(s) {
  const t = String(s);
  if (/[",\r\n]/.test(t)) {
    return `"${t.replace(/"/g, '""')}"`;
  }
  return t;
}

/** 追加在「保留原始列」之后的新列名（顺序固定） */
export const APPENDED_EXPORT_COLUMNS = Object.freeze([
  'sourceLevel',
  'operator',
  'targetLevel',
  'HasZOperator',
]);

/** 可选「Index」列在最前面的表头名 */
export const INDEX_COLUMN_NAME = 'Index';

/**
 * @typedef {{
 *   originalRow: string[] | null,
 *   item: import('./bundle.js').BundleItem,
 * }} ExportEntry
 *
 * @typedef {{
 *   header?: string[] | null,            // 原始 CSV 表头（无表头/无原始 CSV 时为 null）
 *   originalColumnCount?: number,         // 原始 CSV 列数（用于无表头时对齐）
 *   entries: ExportEntry[],
 *   operatorOf: (ops: Array<{ type: string }>) => string,
 *   withBom?: boolean,
 *   withIndex?: boolean,                  // 在最前追加 1 起的自增 Index 列
 *   indexStart?: number,                  // 自增起始值（默认 1）
 * }} ExportCsvOptions
 */

/**
 * 导出 CSV：保留原始 CSV 的列，追加 4 个新列：
 * `sourceLevel, operator, targetLevel, HasZOperator`。
 *
 * - 没有原始 CSV 时（如手动新增的预览框），仅输出 4 列。
 * - 没有表头但有列数时，原始列以「列 0、列 1…」展示在表头。
 *
 * @param {ExportCsvOptions} options
 * @returns {string}
 */
export function serializeExportCsv(options) {
  const {
    header,
    originalColumnCount,
    entries,
    operatorOf,
    withBom = true,
    withIndex = false,
    indexStart = 1,
  } = options;

  const baseColCount =
    header != null
      ? header.length
      : Math.max(
          originalColumnCount ?? 0,
          ...entries.map((e) => (e.originalRow ? e.originalRow.length : 0)),
        );

  const baseHeader =
    header != null
      ? header.slice()
      : Array.from({ length: baseColCount }, (_, i) => `列 ${i}`);

  const fullHeader = [
    ...(withIndex ? [INDEX_COLUMN_NAME] : []),
    ...baseHeader,
    ...APPENDED_EXPORT_COLUMNS,
  ];
  const lines = [fullHeader.map(escapeCsvField).join(',')];

  let i = 0;
  for (const { originalRow, item } of entries) {
    const baseCells = Array.from(
      { length: baseColCount },
      (_, j) => (originalRow && originalRow[j] != null ? originalRow[j] : ''),
    );
    const operator = operatorOf(item.operations ?? []);
    const appended = [
      item.sourceLevelStr ?? '',
      operator,
      item.levelStr ?? '',
      item.meta?.hadZAxisOperation ? '1' : '0',
    ];
    const cells = withIndex
      ? [String(indexStart + i), ...baseCells, ...appended]
      : [...baseCells, ...appended];
    lines.push(cells.map(escapeCsvField).join(','));
    i++;
  }

  const body = `${lines.join('\r\n')}\r\n`;
  return withBom ? `\uFEFF${body}` : body;
}
