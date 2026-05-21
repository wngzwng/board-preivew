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
 * 一次性读整个文件为 UTF-8 文本——**仅适用于小文件**（数十 MB 以内）。
 *
 * 浏览器 / V8 在数百 MB 字符串上会 OOM 或静默返回空，触发"CSV 为空或无法解析"
 * 等假阳性错误。大 CSV 路径请改用 {@link streamTextFileUtf8}。
 *
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
 * 流式把文件按 UTF-8 解码为文本 chunk，喂给回调。
 *
 * 内部用 `File.stream() → TextDecoderStream` 异步迭代，**不**把整个文件放进单个
 * 字符串——内存峰值取决于 chunk 大小（浏览器实现，通常 ~64 KB / chunk）+
 * 调用方在回调里持有的状态。
 *
 * 适用场景：
 * - 大 CSV（数百 MB ~ GB）的流式解析；
 * - 进度回显（onProgress 给出"已读字节数 / 总字节数"）；
 * - 可取消（AbortSignal）。
 *
 * 错误传播：reader / decoder 抛错或被取消时，整个 Promise 拒绝。
 *
 * @param {File} file
 * @param {(chunk: string) => void | Promise<void>} onChunk
 * @param {{
 *   onProgress?: (loaded: number, total: number) => void,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<void>}
 */
export async function streamTextFileUtf8(file, onChunk, options = {}) {
  const { onProgress, signal } = options;
  if (signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }
  const total = file.size;
  // 优先使用 TextDecoderStream（更省内存），不支持时回退到手动 TextDecoder。
  const supportsTextDecoderStream = typeof TextDecoderStream !== 'undefined';
  let loaded = 0;

  if (supportsTextDecoderStream) {
    const stream = file.stream().pipeThrough(new TextDecoderStream('utf-8'));
    const reader = stream.getReader();
    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel();
          throw new DOMException('已取消', 'AbortError');
        }
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          // TextDecoderStream 不直接给出"字节"进度，按 UTF-8 估算
          loaded += value.length; // 粗略：进度条用，不要求精确字节
          await onChunk(value);
          onProgress?.(Math.min(loaded, total), total);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  // 回退：手动跑 ReadableStream<Uint8Array> + TextDecoder，注意保留 stream=true
  // 以正确处理跨 chunk 的 UTF-8 多字节序列。
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        throw new DOMException('已取消', 'AbortError');
      }
      const { value, done } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) await onChunk(tail);
        break;
      }
      if (value) {
        loaded += value.byteLength;
        const text = decoder.decode(value, { stream: true });
        if (text) await onChunk(text);
        onProgress?.(loaded, total);
      }
    }
  } finally {
    reader.releaseLock();
  }
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
