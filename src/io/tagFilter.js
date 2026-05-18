/**
 * 标签纯函数模块：被「D1 删除拦截」、「B4 使用计数」、「C2 筛选视图」、
 * 「多标签导出浮层」四处共用，避免各自维护一份相似实现导致语义漂移。
 *
 * 这里只关心数据：不依赖 DOM、不依赖具体 entry 形状，
 * 调用方负责把 entry 映射成 tag 列表后再传入。
 */

/**
 * 从单个 entry 中提取其当前 tag 列表，兼顾「未水合」场景：
 * - 已水合：从 cellEl 取最新值
 * - 未水合：从导入快照取，保证大量 CSV 未滚动到时统计也不漏
 *
 * @typedef {{
 *   cellEl?: { readTags?: () => string[] } | null,
 *   item?: { tags?: string[] | null } | null,
 * }} TagEntry
 *
 * @param {TagEntry} entry
 * @returns {string[]}
 */
export function readEntryTags(entry) {
  if (!entry) return [];
  const live = entry.cellEl?.readTags?.();
  if (Array.isArray(live)) return live;
  const snap = entry.item?.tags;
  return Array.isArray(snap) ? snap : [];
}

/**
 * 统计每个 tag 在多少个 entry 中被选中。
 *
 * 返回对象**包含**所有出现在任何 entry 中或预设里的 tag；
 * 对于「预设但没人用」的 tag，键存在、值为 0，便于 UI 标记可清理状态。
 *
 * @param {TagEntry[]} entries
 * @param {string[]} [predefined]
 * @returns {Record<string, number>}
 */
export function countTagUsage(entries, predefined = []) {
  /** @type {Record<string, number>} */
  const counts = Object.create(null);
  for (const t of predefined) {
    if (typeof t === 'string' && t) counts[t] = 0;
  }
  if (!Array.isArray(entries)) return counts;
  for (const e of entries) {
    const tags = readEntryTags(e);
    if (!tags.length) continue;
    const seen = new Set();
    for (const t of tags) {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      counts[t] = (counts[t] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * 通用 tag 过滤判定：与 [docs/proposals/multi-tag-export.md §4.1] 同语义。
 *
 * - `any.length === 0` 视为该约束不参与判断（OR 留空 = 不限）
 * - `all` 全部必须存在于 cellTags（AND）
 * - `none` 全部不能存在（NOT）
 * - `mode === 'substring'` 时使用子串匹配，否则精确比较
 *
 * @param {readonly string[]} cellTags
 * @param {{
 *   any?: readonly string[],
 *   all?: readonly string[],
 *   none?: readonly string[],
 *   mode?: 'exact' | 'substring',
 * }} filter
 * @returns {boolean}
 */
export function matchTagFilter(cellTags, filter) {
  if (!filter || typeof filter !== 'object') return true;
  const tags = Array.isArray(cellTags) ? cellTags : [];
  const mode = filter.mode === 'substring' ? 'substring' : 'exact';
  const any = Array.isArray(filter.any) ? filter.any : [];
  const all = Array.isArray(filter.all) ? filter.all : [];
  const none = Array.isArray(filter.none) ? filter.none : [];
  const hit = (needle) => {
    if (needle == null) return false;
    if (mode === 'substring') {
      return tags.some((t) => typeof t === 'string' && t.includes(needle));
    }
    return tags.includes(needle);
  };
  if (any.length && !any.some((n) => hit(n))) return false;
  if (all.length && !all.every((n) => hit(n))) return false;
  if (none.length && none.some((n) => hit(n))) return false;
  return true;
}
