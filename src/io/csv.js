/**
 * CSV 解析与导出（无第三方依赖）。
 * 导入：支持按列索引提取；表头可由 UI 读取后供用户选择列（默认 `Content`）。
 */

import { readTextFileUtf8, streamTextFileUtf8 } from './bundle.js';

/** 默认关卡串所在列表头名（不区分大小写） */
export const DEFAULT_CONTENT_COLUMN = 'Content';

/** 默认 Tags 所在列表头名（不区分大小写） */
export const DEFAULT_TAGS_COLUMN = 'Tags';

/** 默认 Offset 所在列表头名（不区分大小写） */
export const DEFAULT_OFFSET_COLUMN = 'Offset';

/**
 * Tags 单元格在 CSV 中使用的写出分隔符。
 * - 选用 `|` 而非 `,`：避免被 CSV 引擎再包一层双引号，肉眼可读
 * - 解析时同时容忍 `,` / `;` / `|` / 空白，便于人工编辑后再导入
 */
export const TAGS_CSV_SEPARATOR = '|';

/**
 * 解析单个「Tags 列」单元格为 tag 数组：
 * - 空字符串返回 `[]`
 * - 切分符号集：`|`、`,`、`，`、`;`、`；`、连续空白
 * - 自动 `trim` 与去重，保持原始出现顺序
 *
 * @param {string} cell
 * @returns {string[]}
 */
export function parseTagsCellValue(cell) {
  const raw = String(cell ?? '').trim();
  if (!raw) return [];
  const parts = raw.split(/[|,，;；\s]+/);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * 把 tag 数组拼接成可写入 CSV 的单元格字符串（写出统一用 {@link TAGS_CSV_SEPARATOR}）。
 *
 * @param {readonly string[]} tags
 * @returns {string}
 */
export function joinTagsForCsv(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  return tags
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
    .join(TAGS_CSV_SEPARATOR);
}

/**
 * 匹配 {@link DEFAULT_TAGS_COLUMN} 的列索引；无匹配则 -1（视为「无」）。
 * 与 {@link defaultContentColumnIndex} 不同：未命中时不退回 0，
 * 因为「没有 Tags 列」是合法默认状态。
 *
 * @param {string[]} headerLikeLabels
 * @returns {number}
 */
export function defaultTagsColumnIndex(headerLikeLabels) {
  const want = DEFAULT_TAGS_COLUMN.toLowerCase();
  return headerLikeLabels.findIndex(
    (l) => String(l ?? '').trim().toLowerCase() === want,
  );
}

/**
 * 匹配 {@link DEFAULT_OFFSET_COLUMN} 的列索引；无匹配则 -1（"没有 Offset 列"是合法默认）。
 * 与 {@link defaultTagsColumnIndex} 同策略。
 *
 * @param {string[]} headerLikeLabels
 * @returns {number}
 */
export function defaultOffsetColumnIndex(headerLikeLabels) {
  const want = DEFAULT_OFFSET_COLUMN.toLowerCase();
  return headerLikeLabels.findIndex(
    (l) => String(l ?? '').trim().toLowerCase() === want,
  );
}

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
 * 流式 CSV 解析器：把任意大小的文本按 chunk 喂入，每解析出一行就回调一次。
 *
 * 与 {@link parseCsv} 严格同语义：
 * - `"..."` 包围 + `""` 转义；
 * - `\n` / `\r` / `\r\n` 任一作为行终止；
 * - 整行全空白（含纯空字段）的行被丢弃，行长度 ≥ 2 的全空行保留为占位。
 *
 * 设计目的是处理"浏览器 readAsText 跑不动的大文件"（数百 MB ~ GB）。
 * 调用方负责把 `File.stream() / TextDecoderStream` 的 chunk 序列喂给 `feed`，
 * 最后调一次 `end`。
 *
 * **跨 chunk 边界的两个易错点**已处理：
 * 1. `""` 转义可能被切到两个 chunk 中——若 chunk 末尾正好是引号内的 `"`，
 *    暂存到 carry，下次 feed 时拼回开头再判断。
 * 2. `\r\n` 也可能跨边界——若 chunk 末尾是 `\r`（且不在引号内），暂记
 *    "刚 flush 过"，下一 chunk 首字符若为 `\n` 则跳过；这与 parseCsv 内
 *    `if (text[i + 1] === '\n') i++` 一致。
 *
 * @param {(row: string[]) => void} onRow 每完成一行就回调一次（同步）
 * @returns {{ feed: (chunk: string) => void, end: () => void }}
 */
export function createCsvStreamParser(onRow) {
  let row = [];
  let field = '';
  let inQuotes = false;
  /** 上一个 feed 末尾留下的"引号内单 `"`"，等下次首字符联合判断转义 */
  let carryQuote = false;
  /** 上一个 feed 以 `\r` 结尾（且已 flushRow）：下次 feed 首字符若 `\n` 应跳过 */
  let pendingLfSkip = false;
  let bomChecked = false;

  const flushRow = () => {
    row.push(field);
    field = '';
    const nonEmpty = row.some((c) => String(c).trim() !== '');
    if (nonEmpty || row.length > 1) {
      onRow(row);
    }
    row = [];
  };

  /** 处理一个非控制状态下的字符（不在 inQuotes 内）。 */
  const handleUnquoted = (c, next) => {
    if (c === '"') {
      inQuotes = true;
      return 0;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      return 0;
    }
    if (c === '\n') {
      flushRow();
      return 0;
    }
    if (c === '\r') {
      flushRow();
      if (next === '\n') return 1; // 同 chunk 内可立即跳过下一个字符
      pendingLfSkip = true; // 跨 chunk 时延迟到下一次 feed
      return 0;
    }
    field += c;
    return 0;
  };

  return {
    feed(chunk) {
      if (!chunk) return;
      if (!bomChecked) {
        bomChecked = true;
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      }
      let i = 0;
      // 上次 feed 切在引号转义中间：用本次首字符决定是转义 `"` 还是闭合引号
      if (carryQuote) {
        carryQuote = false;
        if (chunk[0] === '"') {
          field += '"';
          i = 1;
        } else {
          inQuotes = false;
        }
      }
      // 上次 feed 末尾是 `\r`：若本次首字符是 `\n` 则跳过，避免 `\r\n` 产生空行
      if (pendingLfSkip) {
        pendingLfSkip = false;
        if (chunk[i] === '\n') i++;
      }
      const len = chunk.length;
      while (i < len) {
        const c = chunk[i];
        if (inQuotes) {
          if (c === '"') {
            if (i + 1 < len) {
              if (chunk[i + 1] === '"') {
                field += '"';
                i += 2;
                continue;
              }
              inQuotes = false;
              i++;
              continue;
            }
            // 末尾的 `"`，单独决策推迟到下一次 feed
            carryQuote = true;
            return;
          }
          field += c;
          i++;
          continue;
        }
        const skip = handleUnquoted(c, i + 1 < len ? chunk[i + 1] : null);
        i += 1 + skip;
      }
    },
    end() {
      // 文件结尾的善后：carryQuote 若还在 = 单独的闭合 `"`；pendingLfSkip 直接忽略
      if (carryQuote) {
        carryQuote = false;
        inQuotes = false;
      }
      // 如果还有数据在 field/row 中（最后一行没有换行符），补 flush 一次。
      if (field.length > 0 || row.length > 0) {
        flushRow();
      }
    },
  };
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

/**
 * 流式扫描一个 CSV 文件，每解析出一行就回调一次 `onRow`。
 *
 * 为什么不直接 `readTextFileUtf8 + parseCsv`：超过 ~100 MB 的文件在浏览器中
 * 一次性 `FileReader.readAsText` 容易 OOM 或静默返回空字符串，导致用户看到的
 * "CSV 为空或无法解析"的假阳性错误。流式路径把"分块解码 + 增量解析"绑在
 * 同一条链路上，内存峰值只取决于 chunk 大小与回调里持有的状态。
 *
 * 回调返回 `false` 可以提前终止解析（例如只想读首行）。回调里抛出的异常会被
 * 透传出去，作为整个 Promise 的拒绝原因。
 *
 * @param {File} file
 * @param {(row: string[], rowIndex: number) => boolean | void} onRow
 *        `rowIndex` 从 0 开始；返回 `false` 终止。
 * @param {{
 *   onProgress?: (loaded: number, total: number) => void,
 *   signal?: AbortSignal,
 * }} [options]
 */
export async function streamParseCsvFile(file, onRow, options = {}) {
  const ac = new AbortController();
  const externalSignal = options.signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      ac.abort();
    } else {
      externalSignal.addEventListener('abort', () => ac.abort(), {
        once: true,
      });
    }
  }
  let rowIndex = 0;
  /** @type {unknown} */
  let pendingError = null;
  const parser = createCsvStreamParser((row) => {
    if (pendingError !== null || ac.signal.aborted) return;
    let r;
    try {
      r = onRow(row, rowIndex);
    } catch (e) {
      pendingError = e;
      ac.abort();
      rowIndex += 1;
      return;
    }
    rowIndex += 1;
    if (r === false) ac.abort();
  });
  try {
    await streamTextFileUtf8(
      file,
      (chunk) => {
        if (ac.signal.aborted) return;
        parser.feed(chunk);
      },
      { onProgress: options.onProgress, signal: ac.signal },
    );
  } catch (e) {
    // 我们自己 abort 的视为正常停止；外部 signal abort 时也走这里。
    if (!(e instanceof Error) || e.name !== 'AbortError') {
      if (pendingError !== null) throw pendingError;
      throw e;
    }
  }
  parser.end();
  if (pendingError !== null) throw pendingError;
}

/**
 * 流式读取 CSV 的第一行（用于列选择面板的列名提示），不缓存其余内容。
 *
 * @param {File} file
 * @returns {Promise<string[]>}
 */
export async function readCsvFirstRow(file) {
  /** @type {string[] | null} */
  let firstRow = null;
  await streamParseCsvFile(file, (row) => {
    if (firstRow === null) {
      firstRow = row;
      return false;
    }
  });
  return firstRow ?? [];
}

/** @param {string} s */
function escapeCsvField(s) {
  const t = String(s);
  if (/[",\r\n]/.test(t)) {
    return `"${t.replace(/"/g, '""')}"`;
  }
  return t;
}

/**
 * 追加在「保留原始列」之后的元数据列名（顺序固定）。
 *
 * `sourceOffset / targetOffset` 紧贴 `sourceLevel / targetLevel`，与 offset 的
 * "原始 / 当前"语义对齐；与 `Offset` 主列（在 Tags 之后）是两套独立通道：
 * 元数据列**永远输出**（即使所有 cell 都空 offset），便于下游统一处理。
 */
export const APPENDED_EXPORT_COLUMNS = Object.freeze([
  'sourceLevel',
  'sourceOffset',
  'operator',
  'targetLevel',
  'targetOffset',
  'HasZOperator',
]);

/** 可选「Index」列在最前面的表头名 */
export const INDEX_COLUMN_NAME = 'Index';

/** 追加 Tags 列时使用的表头名 */
export const TAGS_COLUMN_NAME = 'Tags';

/** 追加 Offset 主列时使用的表头名 */
export const OFFSET_COLUMN_NAME = 'Offset';

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
 *   tagsOf?: (item: import('./bundle.js').BundleItem) => readonly string[],
 *   tagsColumnIndex?: number | null,     // 导入时识别到的 Tags 列索引；null=没有，导出会追加新列
 *   offsetOf?: (item: import('./bundle.js').BundleItem) => string,
 *   offsetColumnIndex?: number | null,   // 导入时识别到的 Offset 列索引；null=没有，导出会追加新列
 *   sourceOffsetOf?: (item: import('./bundle.js').BundleItem) => string,
 *   targetOffsetOf?: (item: import('./bundle.js').BundleItem) => string,
 *   withBom?: boolean,
 *   withIndex?: boolean,                  // 在最前追加 1 起的自增 Index 列
 *   indexStart?: number,                  // 自增起始值（默认 1）
 * }} ExportCsvOptions
 */

/**
 * 导出 CSV：保留原始 CSV 的列，追加 `Tags` / `Offset` 主列 + 六个元数据生成列：
 * `Tags, Offset, sourceLevel, sourceOffset, operator, targetLevel, targetOffset, HasZOperator`。
 *
 * - **Tags 列**：识别到原始 Tags 列则**覆盖**为 cell 当前 tags（避免回环导入列重复）；否则在 6 个元数据列前**追加**一列 `Tags`。
 * - **Offset 列**：与 Tags 同策略，识别则覆盖，否则在 Tags 之后追加。
 * - **元数据列**：`sourceOffset / targetOffset` 永远输出（候选 A）；空 offset 写 `''`。
 *
 * 没有原始 CSV 时（如手动新增的预览框），仅输出 `Tags, Offset, 元数据 6 列`。
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
    tagsOf = (item) => item?.tags ?? [],
    tagsColumnIndex = null,
    offsetOf = (item) => item?.offsetStr ?? '',
    offsetColumnIndex = null,
    sourceOffsetOf = (item) => item?.sourceOffsetStr ?? '',
    targetOffsetOf = (item) => item?.offsetStr ?? '',
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

  /** @param {number | null} idx */
  const validIdx = (idx) =>
    Number.isInteger(idx) &&
    /** @type {number} */ (idx) >= 0 &&
    /** @type {number} */ (idx) < baseColCount
      ? /** @type {number} */ (idx)
      : null;

  const tagsOverwriteIdx = validIdx(tagsColumnIndex);
  const offsetOverwriteIdx = validIdx(offsetColumnIndex);
  const appendTagsCol = tagsOverwriteIdx === null;
  const appendOffsetCol = offsetOverwriteIdx === null;

  const fullHeader = [
    ...(withIndex ? [INDEX_COLUMN_NAME] : []),
    ...baseHeader,
    ...(appendTagsCol ? [TAGS_COLUMN_NAME] : []),
    ...(appendOffsetCol ? [OFFSET_COLUMN_NAME] : []),
    ...APPENDED_EXPORT_COLUMNS,
  ];
  const lines = [fullHeader.map(escapeCsvField).join(',')];

  let i = 0;
  for (const { originalRow, item } of entries) {
    const baseCells = Array.from(
      { length: baseColCount },
      (_, j) => (originalRow && originalRow[j] != null ? originalRow[j] : ''),
    );
    const tagsStr = joinTagsForCsv(tagsOf(item));
    if (tagsOverwriteIdx !== null) {
      baseCells[tagsOverwriteIdx] = tagsStr;
    }
    const offsetStr = String(offsetOf(item) ?? '');
    if (offsetOverwriteIdx !== null) {
      baseCells[offsetOverwriteIdx] = offsetStr;
    }
    const operator = operatorOf(item.operations ?? []);
    const appended = [
      item.sourceLevelStr ?? '',
      String(sourceOffsetOf(item) ?? ''),
      operator,
      item.levelStr ?? '',
      String(targetOffsetOf(item) ?? ''),
      item.meta?.hadZAxisOperation ? '1' : '0',
    ];
    const middle = [
      ...(appendTagsCol ? [tagsStr] : []),
      ...(appendOffsetCol ? [offsetStr] : []),
    ];
    const cells = withIndex
      ? [String(indexStart + i), ...baseCells, ...middle, ...appended]
      : [...baseCells, ...middle, ...appended];
    lines.push(cells.map(escapeCsvField).join(','));
    i++;
  }

  const body = `${lines.join('\r\n')}\r\n`;
  return withBom ? `\uFEFF${body}` : body;
}
