/**
 * 导入 / 导出 JSON 包（见 docs/components/io.md）。
 */

export const BUNDLE_VERSION = 1;

/**
 * @typedef {{ type: string, payload?: Record<string, unknown>, at?: string }} OperationRecord
 * @typedef {{
 *   id?: string,
 *   tags: string[],
 *   sourceLevelStr: string,
 *   operations: OperationRecord[],
 *   levelStr: string,
 *   meta: { hadZAxisOperation: boolean },
 * }} BundleItem
 * @typedef {{ version: number, items: BundleItem[] }} ExportBundle
 */

/**
 * @param {unknown} data
 * @returns {ExportBundle}
 */
export function parseExportBundle(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('导入包不是对象');
  }
  const version = /** @type {{ version?: unknown }} */ (data).version;
  if (version !== BUNDLE_VERSION) {
    throw new Error(`不支持的导出版本: ${String(version)}`);
  }
  const items = /** @type {{ items?: unknown }} */ (data).items;
  if (!Array.isArray(items)) {
    throw new Error('导入包缺少 items 数组');
  }
  const normalized = items.map((raw, i) => normalizeItem(raw, i));
  return { version: BUNDLE_VERSION, items: normalized };
}

/** @param {unknown} raw @param {number} index */
function normalizeItem(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`items[${index}] 非法`);
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  const tags = Array.isArray(o.tags)
    ? o.tags.map((t) => String(t))
    : [];
  const operations = Array.isArray(o.operations) ? o.operations : [];
  const levelStr = o.levelStr != null ? String(o.levelStr) : '';
  const sourceLevelStr =
    o.sourceLevelStr != null ? String(o.sourceLevelStr) : levelStr;
  const meta = o.meta && typeof o.meta === 'object'
    ? /** @type {{ hadZAxisOperation?: unknown }} */ (o.meta)
    : {};
  const hadZAxisOperation = Boolean(meta.hadZAxisOperation);
  return {
    id: o.id != null ? String(o.id) : `cell-${index}`,
    tags,
    sourceLevelStr,
    operations: operations.map((op, j) => normalizeOp(op, index, j)),
    levelStr,
    meta: { hadZAxisOperation },
  };
}

/** @param {unknown} raw @param {number} i @param {number} j */
function normalizeOp(raw, i, j) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`items[${i}].operations[${j}] 非法`);
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  return {
    type: String(o.type),
    payload:
      o.payload && typeof o.payload === 'object'
        ? /** @type {Record<string, unknown>} */ (o.payload)
        : {},
    at: o.at != null ? String(o.at) : undefined,
  };
}

/**
 * @param {BundleItem[]} items
 * @returns {string}
 */
export function serializeExportBundle(items) {
  const bundle = { version: BUNDLE_VERSION, items };
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function readTextFileUtf8(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('无法以文本读取文件'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
    reader.readAsText(file, 'UTF-8');
  });
}

/**
 * @param {File} file
 * @returns {Promise<ExportBundle>}
 */
export async function readBundleFromFile(file) {
  const text = await readTextFileUtf8(file);
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`JSON 解析失败: ${msg}`);
  }
  return parseExportBundle(data);
}

/**
 * @param {string} text
 * @param {string} filename
 * @param {string} [mimeType='application/json;charset=utf-8']
 */
export function downloadTextFile(text, filename, mimeType = 'application/json;charset=utf-8') {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
