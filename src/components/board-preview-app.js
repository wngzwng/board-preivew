import './board-preview-cell.js';
import { downloadTextFile } from '../io/bundle.js';
import {
  serializeExportCsv,
  defaultContentColumnIndex,
  defaultTagsColumnIndex,
  defaultOffsetColumnIndex,
  parseTagsCellValue,
  readCsvFirstRow,
  streamParseCsvFile,
  DEFAULT_CONTENT_COLUMN,
  DEFAULT_TAGS_COLUMN,
  DEFAULT_OFFSET_COLUMN,
} from '../io/csv.js';
import { operationsToGlyphString } from '../board/operationGlyphs.js';
import {
  countTagUsage,
  matchTagFilter,
  readEntryTags,
} from '../io/tagFilter.js';
import { tagHue } from '../utils/tagColor.js';

export class BoardPreviewApp extends HTMLElement {
  constructor() {
    super();
    /**
     * 当前已选定但尚未确认导入的 CSV。
     *
     * **流式路径**：不再缓存全部 `rows`——600 MB 量级的 CSV 一次性 readAsText
     * 会让浏览器静默 OOM / 返回空字符串，触发"为空或无法解析"的假阳性错误。
     * 这里只保留 `File` 引用 + 首行（用于列名提示），全文件扫描推迟到
     * `_confirmCsvImport` 中按需做一次。
     *
     * @type {{ file: File, fileName: string, firstRow: string[] } | null}
     */
    this._pendingCsv = null;
    /** "确认导入"流式扫描进行中的并发保护标志 */
    this._csvImporting = false;
    /** 已导入 CSV 的表头（含表头时为首行；无表头为 null） */
    /** @type {string[] | null} */
    this._csvHeader = null;
    /** 已导入 CSV 的列数（无表头时用于补齐输出） */
    this._csvColumnCount = 0;
    /**
     * 导入时识别到的「Tags 所在列」索引；为 null 表示导入时没有 Tags 列，
     * 导出时会**追加**一列 `Tags` 而不是覆盖。
     * @type {number | null}
     */
    this._csvTagsColumnIndex = null;
    /**
     * 导入时识别到的「Offset 所在列」索引；为 null 表示导入时没有 Offset 列，
     * 导出时会**追加**一列 `Offset` 而不是覆盖。
     * @type {number | null}
     */
    this._csvOffsetColumnIndex = null;
    /**
     * 当前 `_pendingCsv` 是否已成功被导入过：
     * 用于把「修改两个列下拉」标记为"会触发重新导入"的高风险操作。
     * - 文件被选中但未点过确认导入 → false
     * - 至少一次确认导入成功 → true，后续修改下拉会弹 toast 警告
     */
    this._csvImported = false;
    /** 用户在页头预设的标签（去重保序，逗号 / 中文逗号 / 空格分隔均可） */
    /** @type {string[]} */
    this._predefinedTags = [];
    /**
     * 上一次成功生效的预设标签快照，用于「删除拦截」的差集判断：
     * 当 `previous \ next` 中存在 Cell 仍在使用的标签时，该次删除被拒绝。
     * 与 `_predefinedTags` 严格保持同步。
     * @type {string[]}
     */
    this._predefinedTagsCommitted = [];
    /**
     * 当前激活的标签筛选（C2）：纯内存状态，刷新即清空。
     * - `tags`：已激活的标签集合
     * - `mode`：多标签命中规则（OR / AND）
     * - `includeUntagged`：是否把"完全没有标签的 Cell"也纳入筛选；
     *   与 `tags` 在 OR 模式下并集，在 AND 模式下交集（通常为空集）
     * - 仅当 `tags.size === 0 && !includeUntagged` 时视为无筛选
     *
     * @type {{ tags: Set<string>, mode: 'or' | 'and', includeUntagged: boolean }}
     */
    this._tagFilter = { tags: new Set(), mode: 'or', includeUntagged: false };
    /**
     * 待执行的 summary 刷新 rAF 句柄；用于把同一帧内多次 bp-cell-change 合并成一次渲染。
     * @type {number | null}
     */
    this._summaryRafId = null;
    /**
     * 待执行的 status 刷新 rAF 句柄；用于把同一帧内多次 hydrate/dehydrate 合并成一次渲染。
     * @type {number | null}
     */
    this._statusRafId = null;
    /**
     * 多标签导出浮层的当前会话状态；为 null 表示浮层未打开。
     * 关闭即丢弃，不写 localStorage（与 multi-tag-export.md §8 决策一致）。
     * @type {{ tags: Set<string>, mode: 'or' | 'and', root: HTMLElement } | null}
     */
    this._exportTagModal = null;
    /**
     * dragenter / dragleave 计数器：进入子元素也会触发 enter/leave，必须用计数器
     * 才能正确判断「拖拽是否真正离开了 `<bp-app>`」。
     */
    this._dragCounter = 0;
    /**
     * @param {KeyboardEvent} e
     */
    this._onExportTagModalKey = (e) => {
      if (e.key === 'Escape') this._closeExportTagModal();
    };
    /**
     * 全部预览框条目（懒渲染源）。`cellEl` 为 null 时仍是骨架，进入视口后才水合。
     * @type {Array<{
     *   kind: 'csv' | 'manual',
     *   el: HTMLElement,
     *   cellEl: import('./board-preview-cell.js').BoardPreviewCell | null,
     *   item: object,
     *   originalRow: string[] | null,
     *   csvRow: number | null,
     * }>}
     */
    this._entries = [];
    /**
     * 元素 → entry 反查；同时支撑两种 observer：
     * - 未水合：key 为 skeleton 元素，hydrate observer 用它定位 entry；
     * - 已水合：key 为 cell 元素，dehydrate observer 用它定位 entry。
     * @type {WeakMap<Element, object>}
     */
    this._entryByEl = new WeakMap();
    /** @type {IntersectionObserver | null} */
    this._observer = null;
    /** @type {IntersectionObserver | null} */
    this._dehydrateObserver = null;
    /**
     * 当前处于已水合状态的 entry 数量，增量维护。十万级 entry 时直接 reduce
     * 会让每次 hydrate / dehydrate 都触发 O(N) 扫描，滚动会被状态行拖到不可用。
     */
    this._hydratedCount = 0;
    /**
     * Z 轴视觉偏移（仅渲染效果，不影响 levelStr / operations / 导出）。
     * x、y 单位为「棋子宽度的百分比」，可正可负。
     * 默认开启 + 右上方向偏移（offsetX=+8%、offsetY=-10%）。
     * @type {{ enabled: boolean, x: number, y: number }}
     */
    this._zOffset = this._loadZOffset();
    /**
     * 全局「Offset 视觉效果」开关：true 时把每个 Cell 解析出来的柱子级 offset
     * 反映到棋盘渲染（CSS 平移 + PNG 像素平移）。
     *
     * 与 Z 偏移开关**独立**且**可叠加**——
     * 二者本质都是视觉 translate，仅作用范围不同（offset 一柱、Z 偏移按层）。
     * @type {boolean}
     */
    this._offsetEnabled = this._loadOffsetEnabled();
    /**
     * 全局「Offset 单层增量缩放系数」（百分比整数，1–5）。
     *
     * 实际单层增量 = `(magnitude + 1) × offsetUnitPct%`（相对棋子宽度）。
     * 默认 1（=protocol-level `OFFSET_UNIT × 100`），等价于"最大 6%/层"；
     * 调到 5 时最大 30%/层，给 offset 设计更宽的视觉空间。
     * 协议层的 `OFFSET_UNIT = 1/100` 不动——这只是**渲染端**视觉缩放。
     * @type {number}
     */
    this._offsetUnitPct = this._loadOffsetUnitPct();
    /**
     * 全局「Cell 折叠」开关：true 时所有 Cell 仅显示
     * 序号 / 棋盘 / x,y,z 范围 / 复制按钮 / 标签添加入口，
     * 隐藏其余编辑控件以让棋盘成为视觉主体。
     * @type {boolean}
     */
    this._cellsCollapsed = this._loadCellsCollapsed();
  }

  /** @returns {boolean} */
  _loadCellsCollapsed() {
    try {
      const raw = window.localStorage?.getItem(
        BoardPreviewApp.CELLS_COLLAPSED_KEY,
      );
      return raw === '1';
    } catch {
      return false;
    }
  }

  _saveCellsCollapsed() {
    try {
      window.localStorage?.setItem(
        BoardPreviewApp.CELLS_COLLAPSED_KEY,
        this._cellsCollapsed ? '1' : '0',
      );
    } catch {
      // 隐私模式 / 配额超限时静默
    }
  }

  /** @returns {{ enabled: boolean, x: number, y: number }} */
  _defaultZOffset() {
    return { enabled: true, x: -3, y: -3 };
  }

  /** 从 localStorage 读取偏移设置，失败时回退默认值 */
  _loadZOffset() {
    const defaults = this._defaultZOffset();
    try {
      const raw = window.localStorage?.getItem(BoardPreviewApp.Z_OFFSET_KEY);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      return {
        enabled: typeof parsed.enabled === 'boolean'
          ? parsed.enabled
          : defaults.enabled,
        x: Number.isFinite(parsed.x) ? parsed.x : defaults.x,
        y: Number.isFinite(parsed.y) ? parsed.y : defaults.y,
      };
    } catch {
      return defaults;
    }
  }

  _saveZOffset() {
    try {
      window.localStorage?.setItem(
        BoardPreviewApp.Z_OFFSET_KEY,
        JSON.stringify(this._zOffset),
      );
    } catch {
      // 隐私模式 / 配额超限时静默
    }
  }

  /**
   * 全局 offset 视觉开关：默认开启（与"粘贴 offset 即可见效果"语义一致）。
   * @returns {boolean}
   */
  _loadOffsetEnabled() {
    try {
      const raw = window.localStorage?.getItem(
        BoardPreviewApp.OFFSET_ENABLED_KEY,
      );
      if (raw === null || raw === undefined) return true;
      return raw === '1';
    } catch {
      return true;
    }
  }

  _saveOffsetEnabled() {
    try {
      window.localStorage?.setItem(
        BoardPreviewApp.OFFSET_ENABLED_KEY,
        this._offsetEnabled ? '1' : '0',
      );
    } catch {
      // 隐私模式 / 配额超限时静默
    }
  }

  /**
   * 全局 offset 单位缩放系数（百分比整数，1–5）；默认 1。
   * @returns {number}
   */
  _loadOffsetUnitPct() {
    try {
      const raw = window.localStorage?.getItem(
        BoardPreviewApp.OFFSET_UNIT_PCT_KEY,
      );
      const n = raw == null ? 1 : Number(raw);
      return this._clampOffsetUnitPct(Number.isFinite(n) ? n : 1);
    } catch {
      return 1;
    }
  }

  _saveOffsetUnitPct() {
    try {
      window.localStorage?.setItem(
        BoardPreviewApp.OFFSET_UNIT_PCT_KEY,
        String(this._offsetUnitPct),
      );
    } catch {
      // 隐私模式 / 配额超限时静默
    }
  }

  /** 把任意输入收敛到合法整数 [1, 5]。 */
  _clampOffsetUnitPct(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(5, n));
  }

  /** @param {string} raw */
  _parsePredefinedTags(raw) {
    return Array.from(
      new Set(
        String(raw)
          .split(/[，,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
  }

  /**
   * 渲染 Z 轴偏移控件（页头完整版）：开关 + 两个百分比输入 + 重置按钮。
   * @param {'header'} variant
   */
  _zOffsetGroupHtml(variant) {
    const z = this._zOffset;
    return `
      <span class="bp-zoffset bp-zoffset--${variant}" role="group" aria-label="Z 轴偏移控制">
        <label class="bp-zoffset__toggle">
          <input
            type="checkbox"
            class="bp-zoffset__toggle-input"
            data-role="zoffset-toggle"
            ${z.enabled ? 'checked' : ''}
          />
          <span>Z 轴偏移</span>
        </label>
        <label class="bp-zoffset__field">
          <span class="bp-zoffset__label">X</span>
          <input
            type="number"
            class="bp-zoffset__input"
            data-role="zoffset-x"
            step="1"
            value="${z.x}"
            aria-label="X 偏移百分比"
          />
          <span class="bp-zoffset__unit">%</span>
        </label>
        <label class="bp-zoffset__field">
          <span class="bp-zoffset__label">Y</span>
          <input
            type="number"
            class="bp-zoffset__input"
            data-role="zoffset-y"
            step="1"
            value="${z.y}"
            aria-label="Y 偏移百分比"
          />
          <span class="bp-zoffset__unit">%</span>
        </label>
        <button type="button" class="bp-btn bp-btn--sm" data-action="reset-zoffset" aria-label="重置默认">重置</button>
      </span>
    `;
  }

  /**
   * 渲染「全部折叠 / 展开」全局按钮。所有入口共用同一 data-action，
   * UI 通过 _syncCellsCollapseUi 双向同步文案。
   * @param {'header' | 'sticky'} variant
   */
  _collapseToggleHtml(variant) {
    const collapsed = this._cellsCollapsed;
    const label = collapsed ? '展开全部' : '折叠全部';
    const hint = collapsed
      ? '当前为「棋盘优先」紧凑视图，点击展开所有编辑控件'
      : '隐藏每个 Cell 的编辑控件，让棋盘成为主体';
    return `
      <button
        type="button"
        class="bp-btn bp-btn--sm bp-app__collapse-toggle bp-app__collapse-toggle--${variant}"
        data-action="toggle-cells-collapse"
        aria-pressed="${collapsed ? 'true' : 'false'}"
        title="${hint}"
      >${label}</button>
    `;
  }

  /**
   * 渲染 Z 轴偏移紧凑开关（sticky 版本）：只一个复选框，与页头开关双向同步。
   * @param {'sticky'} variant
   */
  _zOffsetToggleHtml(variant) {
    const z = this._zOffset;
    return `
      <label class="bp-zoffset-toggle bp-zoffset-toggle--${variant}">
        <input
          type="checkbox"
          data-role="zoffset-toggle"
          ${z.enabled ? 'checked' : ''}
        />
        <span>Z 偏移</span>
      </label>
    `;
  }

  /**
   * 渲染「Offset 视觉效果」全局开关 + 单位缩放系数输入（与 Z 偏移开关样式一致）。
   * 页头/sticky 双入口；开关 data-role="offset-toggle"，单位输入 data-role="offset-unit-pct"，
   * 都通过 _syncOffsetUi 与所有同类元素双向同步。
   * @param {'header' | 'sticky'} variant
   */
  _offsetToggleHtml(variant) {
    return `
      <span class="bp-offset-group bp-offset-group--${variant}" role="group" aria-label="Offset 视觉效果">
        <label
          class="bp-offset-toggle bp-offset-toggle--${variant}"
          title="是否把每个 Cell 解析出的 offset 反映到棋盘渲染（与 Z 偏移可叠加）"
        >
          <input
            type="checkbox"
            data-role="offset-toggle"
            ${this._offsetEnabled ? 'checked' : ''}
          />
          <span>Offset</span>
        </label>
        <label
          class="bp-offset-unit bp-offset-unit--${variant}"
          title="offset 单层增量缩放系数（1–5%），档位 k 对应 (k+1) × 此值 / 层"
        >
          <span class="bp-offset-unit__label">单位</span>
          <input
            type="number"
            class="bp-offset-unit__input"
            data-role="offset-unit-pct"
            min="1"
            max="5"
            step="1"
            value="${this._offsetUnitPct}"
            aria-label="Offset 单位百分比（1–5）"
          />
          <span class="bp-offset-unit__suffix">%</span>
        </label>
      </span>
    `;
  }

  /**
   * 渲染一个跳转组 HTML 片段，所有跳转入口（页头/sticky）共用。
   * @param {'header' | 'sticky'} variant
   */
  _jumpGroupHtml(variant) {
    return `
      <span class="bp-jump bp-jump--${variant}" role="group" aria-label="快速跳转">
        <span class="bp-jump__label">跳到 #</span>
        <input
          type="number"
          class="bp-jump__input"
          min="1"
          step="1"
          inputmode="numeric"
          placeholder="序号"
          autocomplete="off"
          data-role="jump-input"
          aria-label="跳转到指定序号"
        />
        <span class="bp-jump__total" data-role="jump-total">/ 0</span>
        <button type="button" class="bp-btn bp-btn--sm" data-action="jump-to">跳转</button>
      </span>
    `;
  }

  connectedCallback() {
    this.innerHTML = `
      <header class="bp-app__header">
        <h1 class="bp-app__title">Board 预览 <span class="bp-app__badge">Tile3</span></h1>
        <p class="bp-app__sub">羊了个羊式叠层 · 多预览框 · 资源见 <code>src/assets/</code></p>
        <div class="bp-app__actions">
          <button type="button" class="bp-btn bp-btn--primary" data-action="add-cell">＋ 预览框</button>
        </div>
        <div class="bp-app__csv" aria-label="CSV 导入导出">
          <span class="bp-app__csv-hint">CSV：<strong>点击按钮选择</strong>或<strong>拖拽 .csv 文件到页面</strong>导入；下方选择关卡串所在列（默认 <code>${DEFAULT_CONTENT_COLUMN}</code>）、标签所在列（默认 <code>${DEFAULT_TAGS_COLUMN}</code>，无此列则为「无」）、Offset 所在列（默认 <code>${DEFAULT_OFFSET_COLUMN}</code>，无此列则为「无」），列名均不区分大小写。</span>
          <div class="bp-csv-row">
            <label class="bp-csv-field bp-csv-field--check">
              <input type="checkbox" class="bp-csv-header" checked />
              首行作为表头
            </label>
            <label class="bp-btn bp-file">选择 CSV 文件
              <input type="file" class="bp-app__csv-file" accept=".csv,text/csv" data-role="csv-file" hidden />
            </label>
          </div>
          <div class="bp-csv-confirm" hidden>
            <span class="bp-csv-confirm__name"></span>
            <label class="bp-csv-field bp-csv-field--grow">关卡串所在列
              <select class="bp-csv-column-select" aria-label="选择内容列"></select>
            </label>
            <label class="bp-csv-field bp-csv-field--grow">标签所在列
              <select class="bp-csv-tags-select" aria-label="选择标签列（可选）"></select>
            </label>
            <label class="bp-csv-field bp-csv-field--grow">Offset 所在列
              <select class="bp-csv-offset-select" aria-label="选择 Offset 列（可选）"></select>
            </label>
            <button type="button" class="bp-btn bp-btn--primary" data-action="confirm-csv-import">确认导入</button>
            <button type="button" class="bp-btn" data-action="cancel-csv-import">取消</button>
            <span class="bp-csv-confirm__progress" hidden aria-live="polite"></span>
          </div>
          <div class="bp-csv-row">
            <button type="button" class="bp-btn" data-action="export-csv">导出 CSV</button>
            <button
              type="button"
              class="bp-btn"
              data-action="export-csv-tag-multi"
              title="弹出多选浮层（支持 AND / OR）"
            >按标签导出 CSV…</button>
            <button
              type="button"
              class="bp-btn"
              data-action="export-csv-tag"
              title="单关键字子串匹配（弹出输入框）"
            >按关键词导出 CSV</button>
            <label class="bp-csv-field bp-csv-field--check">
              <input type="checkbox" class="bp-csv-export-index" data-role="index-toggle" />
              添加 Index 列（1 起自增）
            </label>
          </div>
        </div>
        <div class="bp-app__jump-bar" aria-label="快速跳转">
          ${this._jumpGroupHtml('header')}
          <span class="bp-app__jump-hint">输入序号后按 Enter 或点「跳转」，目标会尽量滚动到视口中央</span>
        </div>
        <div class="bp-app__zoffset-bar" aria-label="Z 轴偏移">
          ${this._offsetToggleHtml('header')}
          ${this._zOffsetGroupHtml('header')}
          <span class="bp-app__zoffset-hint">每升一层 z 按棋子宽度的百分比偏移（仅渲染效果，不影响导出）。</span>
          ${this._collapseToggleHtml('header')}
        </div>
        <div class="bp-app__tags" aria-label="预设标签">
          <label class="bp-app__tags-field">
            <span class="bp-app__tags-label">预设标签</span>
            <input
              type="text"
              class="bp-app__tags-input"
              placeholder="逗号分隔，例如: 简单, 中等, 困难, 测试"
              autocomplete="off"
              spellcheck="false"
              data-role="tags-input"
            />
          </label>
          <span class="bp-app__tags-hint">
            预览框只能从下拉选择已有标签；移除某个标签前请先在 Cell 中清空它的使用。
          </span>
          <div class="bp-app__tag-stats-wrap" aria-label="标签使用统计与筛选">
            <div class="bp-app__tag-stats-ctrl">
              <span class="bp-app__tag-stats-ctrl-label">筛选</span>
              <button
                type="button"
                class="bp-btn bp-btn--sm bp-app__filter-mode"
                data-action="toggle-filter-mode"
                aria-pressed="false"
                title="切换筛选模式：OR=任一命中即显示；AND=必须全部含才显示"
              >OR</button>
              <button
                type="button"
                class="bp-btn bp-btn--sm bp-app__filter-clear"
                data-action="clear-tag-filter"
                hidden
              >清空筛选</button>
              <span class="bp-app__filter-empty" data-role="filter-empty">点击下方标签即可只显示包含该标签的预览框</span>
            </div>
            <div class="bp-app__tag-stats" role="list" data-role="tag-stats"></div>
          </div>
        </div>
        <div class="bp-app__sentinel" aria-hidden="true"></div>
      </header>
      <div class="bp-app__sticky" hidden role="toolbar" aria-label="快捷栏">
        <div class="bp-app__sticky-row">
          <button type="button" class="bp-btn bp-btn--primary" data-action="add-cell">＋ 预览框</button>
          <label class="bp-btn bp-file">
            选择 CSV
            <input type="file" class="bp-app__csv-file-sticky" accept=".csv,text/csv" data-role="csv-file" hidden />
          </label>
          <button type="button" class="bp-btn" data-action="export-csv">导出 CSV</button>
          <button
            type="button"
            class="bp-btn"
            data-action="export-csv-tag-multi"
            title="弹出多选浮层（支持 AND / OR）"
          >按标签导出 CSV…</button>
          <button
            type="button"
            class="bp-btn"
            data-action="export-csv-tag"
            title="单关键字子串匹配（弹出输入框）"
          >按关键词导出 CSV</button>
          <label class="bp-csv-field bp-csv-field--check">
            <input type="checkbox" class="bp-csv-export-index" data-role="index-toggle" />
            Index 列
          </label>
          ${this._jumpGroupHtml('sticky')}
          ${this._offsetToggleHtml('sticky')}
          ${this._zOffsetToggleHtml('sticky')}
          ${this._collapseToggleHtml('sticky')}
        </div>
        <div class="bp-app__sticky-row bp-app__sticky-row--tags">
          <span class="bp-app__sticky-tags-label">预设标签</span>
          <input
            type="text"
            class="bp-app__tags-input"
            placeholder="逗号分隔"
            autocomplete="off"
            spellcheck="false"
            data-role="tags-input"
          />
        </div>
      </div>
      <div class="bp-app__grid-info" hidden></div>
      <div class="bp-app__grid"></div>
      <div class="bp-app__toast-stack" role="status" aria-live="polite" aria-atomic="false"></div>
    `;
    this._grid = /** @type {HTMLDivElement} */ (
      this.querySelector('.bp-app__grid')
    );

    this.addEventListener('click', (e) => this._onDelegatedClick(e));
    this.addEventListener('change', (e) => this._onDelegatedChange(e));
    this.addEventListener('input', (e) => this._onDelegatedInput(e));
    this.addEventListener('keydown', (e) => this._onDelegatedKeydown(e));
    this.addEventListener('bp:toast', (e) => {
      const detail = /** @type {CustomEvent} */ (e).detail || {};
      this._toast(detail.message, {
        kind: detail.kind,
        ttl: detail.ttl,
      });
    });
    this.addEventListener('bp-cell-change', () => {
      this._scheduleSummaryRefresh();
    });
    this.addEventListener('dragenter', (e) => this._onAppDragEnter(e));
    this.addEventListener('dragover', (e) => this._onAppDragOver(e));
    this.addEventListener('dragleave', (e) => this._onAppDragLeave(e));
    this.addEventListener('drop', (e) => this._onAppDrop(e));

    this._onGlobalKeydown = this._onGlobalKeydown.bind(this);
    document.addEventListener('keydown', this._onGlobalKeydown);

    this._initObserver();
    this._initStickyBar();
    this._applyZOffsetToRoot();
    this._applyOffsetEnabledToRoot();
    this._applyOffsetUnitPctToRoot();
    this._applyCellsCollapsedToRoot();
    this._syncFilterControls();

    if (this._entries.length === 0) {
      this.addCell();
    }
    // 必须在 addCell 之后渲染：第一个手动新增的 cell 也要进入「暂无标签 N」统计
    this._renderPredefinedSummary();
  }

  disconnectedCallback() {
    if (this._onGlobalKeydown) {
      document.removeEventListener('keydown', this._onGlobalKeydown);
    }
  }

  /**
   * 全局键盘快捷键：
   * - Space → 切换全部 Cell 折叠/展开
   * - Z / z → 切换 Z 偏移
   *
   * 仅在以下条件下生效，避免和正在使用的表单/编辑控件冲突：
   * 1. 没有被 meta/ctrl/alt 修饰；
   * 2. 焦点不在输入控件（input / textarea / select / contenteditable）；
   * 3. 焦点不在按钮（避免 Space 同时触发按钮原生 click 与全局快捷键的重复行为）；
   * 4. 当前没有标签导出浮层占据焦点逻辑（浮层关闭时 _exportTagModal 为 null）。
   *
   * @param {KeyboardEvent} e
   */
  _onGlobalKeydown(e) {
    if (e.repeat) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (this._exportTagModal) return;

    const ae = document.activeElement;
    if (ae) {
      const tag = ae.tagName;
      const editing =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        tag === 'BUTTON' ||
        /** @type {HTMLElement} */ (ae).isContentEditable;
      if (editing) return;
    }

    const code = e.code;
    const key = e.key;
    if (code === 'Space' || key === ' ' || key === 'Spacebar') {
      e.preventDefault();
      this._toggleCellsCollapsed();
      return;
    }
    if (key === 'z' || key === 'Z') {
      e.preventDefault();
      this._toggleZOffsetEnabled();
    }
  }

  /**
   * 不依赖 checkbox source 的 Z 偏移切换：用于全局快捷键与未来其他入口。
   * 与 `_onZOffsetToggle(source)` 共用持久化 / 应用 / UI 同步逻辑。
   */
  _toggleZOffsetEnabled() {
    const enabled = !this._zOffset.enabled;
    this._zOffset = { ...this._zOffset, enabled };
    this._saveZOffset();
    this._applyZOffsetToRoot();
    this._syncZOffsetToggleUi();
    this._broadcastZOffset();
  }

  /** @param {Event} e */
  _onDelegatedClick(e) {
    const t = /** @type {HTMLElement | null} */ (e.target);
    if (!t || !t.closest) return;
    const btn = /** @type {HTMLElement | null} */ (t.closest('[data-action]'));
    if (!btn || !this.contains(btn)) return;
    switch (btn.dataset.action) {
      case 'add-cell':
        this.addCell();
        break;
      case 'confirm-csv-import':
        this._confirmCsvImport();
        break;
      case 'cancel-csv-import':
        this._cancelCsvImport();
        break;
      case 'export-csv':
        this.exportCsvAll();
        break;
      case 'export-csv-tag':
        this.exportCsvByTag();
        break;
      case 'export-csv-tag-multi':
        this._openExportTagModal();
        break;
      case 'export-tag-modal-close':
      case 'export-tag-modal-cancel':
        this._closeExportTagModal();
        break;
      case 'export-tag-modal-toggle-mode':
        this._toggleExportModalMode();
        break;
      case 'export-tag-modal-clear':
        this._clearExportModalSelection();
        break;
      case 'export-tag-modal-toggle-tag':
        this._toggleExportModalTag(btn.dataset.tag);
        break;
      case 'export-tag-modal-confirm':
        this._confirmExportTagModal();
        break;
      case 'jump-to':
        this._jumpFromInput(btn);
        break;
      case 'reset-zoffset':
        this._resetZOffset();
        break;
      case 'toggle-cells-collapse':
        this._toggleCellsCollapsed();
        break;
      case 'toggle-tag-filter':
        this._toggleTagFilter(btn.dataset.tag);
        break;
      case 'toggle-untagged-filter':
        this._toggleUntaggedFilter();
        break;
      case 'toggle-filter-mode':
        this._toggleFilterMode();
        break;
      case 'clear-tag-filter':
        this._clearTagFilter();
        break;
      default:
    }
  }

  /** 全局切换 Cell 折叠态：写入 localStorage、刷新根 class 与按钮文案。 */
  _toggleCellsCollapsed() {
    this._cellsCollapsed = !this._cellsCollapsed;
    this._saveCellsCollapsed();
    this._applyCellsCollapsedToRoot();
    this._syncCellsCollapseUi();
  }

  _applyCellsCollapsedToRoot() {
    this.classList.toggle('bp-app--cells-collapsed', this._cellsCollapsed);
  }

  _syncCellsCollapseUi() {
    const btns = this.querySelectorAll(
      'button[data-action="toggle-cells-collapse"]',
    );
    const collapsed = this._cellsCollapsed;
    const label = collapsed ? '展开全部' : '折叠全部';
    const hint = collapsed
      ? '当前为「棋盘优先」紧凑视图，点击展开所有编辑控件'
      : '隐藏每个 Cell 的编辑控件，让棋盘成为主体';
    btns.forEach((b) => {
      const btn = /** @type {HTMLButtonElement} */ (b);
      btn.textContent = label;
      btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
      btn.title = hint;
    });
  }

  /** @param {KeyboardEvent} e */
  _onDelegatedKeydown(e) {
    const t = /** @type {HTMLElement | null} */ (e.target);
    if (!t) return;
    if (e.key === 'Enter' && t.dataset?.role === 'jump-input') {
      e.preventDefault();
      this._jumpFromInput(t);
    }
  }

  /** @param {Event} e */
  _onDelegatedChange(e) {
    const t = /** @type {HTMLElement | null} */ (e.target);
    if (!t) return;
    const role = t.dataset?.role;
    if (role === 'csv-file') {
      this._onCsvFileChosen(/** @type {HTMLInputElement} */ (t));
    } else if (role === 'index-toggle') {
      this._syncIndexToggles(/** @type {HTMLInputElement} */ (t));
    } else if (t.classList.contains('bp-csv-header')) {
      if (this._pendingCsv) this._populateCsvColumnSelect();
      if (this._csvImported) this._warnReimport();
    } else if (
      t.classList.contains('bp-csv-column-select') ||
      t.classList.contains('bp-csv-tags-select') ||
      t.classList.contains('bp-csv-offset-select')
    ) {
      if (this._csvImported) this._warnReimport();
    } else if (role === 'tags-input') {
      this._syncTagsInputs(/** @type {HTMLInputElement} */ (t), { commit: true });
    } else if (role === 'zoffset-toggle') {
      this._onZOffsetToggle(/** @type {HTMLInputElement} */ (t));
    } else if (role === 'zoffset-x' || role === 'zoffset-y') {
      this._onZOffsetNumberChange(/** @type {HTMLInputElement} */ (t));
    } else if (role === 'offset-toggle') {
      this._onOffsetToggle(/** @type {HTMLInputElement} */ (t));
    } else if (role === 'offset-unit-pct') {
      this._onOffsetUnitPctChange(/** @type {HTMLInputElement} */ (t));
    }
  }

  /** @param {Event} e */
  _onDelegatedInput(e) {
    const t = /** @type {HTMLElement | null} */ (e.target);
    if (!t) return;
    const role = t.dataset?.role;
    if (role === 'tags-input') {
      this._syncTagsInputs(/** @type {HTMLInputElement} */ (t), { commit: false });
    } else if (role === 'zoffset-x' || role === 'zoffset-y') {
      this._onZOffsetNumberChange(/** @type {HTMLInputElement} */ (t));
    } else if (role === 'offset-unit-pct') {
      this._onOffsetUnitPctChange(/** @type {HTMLInputElement} */ (t));
    }
  }

  /**
   * 同步两个「预设标签」输入框 + 广播给所有 Cell + 删除拦截。
   *
   * 两阶段：
   * - input 阶段（`commit: false`）：实时跟随用户输入，对「被使用的删除」做软保留：
   *   把仍在被 Cell 使用的标签保留在 `_predefinedTags` 中（broadcast 时不会真正消失），
   *   但不打扰用户、不回滚输入框文本。
   * - change 阶段（`commit: true`，由 blur 或回车等触发）：若仍有被保留的删除项，
   *   把输入框文本硬回滚到 effective 字符串并通过 toast 告知用户原因。
   *
   * @param {HTMLInputElement} source
   * @param {{ commit?: boolean }} [opts]
   */
  _syncTagsInputs(source, opts = {}) {
    const commit = !!opts.commit;
    const previous = this._predefinedTagsCommitted ?? [];
    const requested = this._parsePredefinedTags(source.value);
    const removed = previous.filter((t) => !requested.includes(t));
    const counts = removed.length
      ? countTagUsage(this._entries, removed)
      : Object.create(null);
    const blocked = removed.filter((t) => (counts[t] ?? 0) > 0);
    const effective = blocked.length
      ? [...requested, ...blocked.filter((b) => !requested.includes(b))]
      : requested;

    const otherInputs = this.querySelectorAll('input[data-role="tags-input"]');
    otherInputs.forEach((inp) => {
      const el = /** @type {HTMLInputElement} */ (inp);
      if (el !== source) el.value = source.value;
    });

    if (commit && blocked.length) {
      const joined = effective.join(', ');
      otherInputs.forEach((inp) => {
        /** @type {HTMLInputElement} */ (inp).value = joined;
      });
      const msg =
        blocked.length === 1
          ? `标签「${blocked[0]}」正在被 ${counts[blocked[0]]} 个预览框使用，无法删除`
          : `下列标签仍在被使用，无法删除：${blocked
              .map((t) => `「${t}」(${counts[t]})`)
              .join('、')}`;
      this._toast(msg, { kind: 'error', ttl: 4500 });
    }

    this._predefinedTags = effective;
    this._predefinedTagsCommitted = effective;
    this._broadcastPredefinedTags();
  }

  /** @param {HTMLInputElement} source */
  _onZOffsetToggle(source) {
    const enabled = !!source.checked;
    if (enabled === this._zOffset.enabled) {
      this._syncZOffsetToggleUi();
      return;
    }
    this._zOffset = { ...this._zOffset, enabled };
    this._saveZOffset();
    this._applyZOffsetToRoot();
    this._syncZOffsetToggleUi();
    this._broadcastZOffset();
  }

  /** @param {HTMLInputElement} source */
  _onZOffsetNumberChange(source) {
    const role = source.dataset.role;
    if (role !== 'zoffset-x' && role !== 'zoffset-y') return;
    const raw = Number(source.value);
    if (!Number.isFinite(raw)) return;
    const clamped = Math.max(-200, Math.min(200, raw));
    const next = { ...this._zOffset };
    if (role === 'zoffset-x') next.x = clamped;
    else next.y = clamped;
    if (next.x === this._zOffset.x && next.y === this._zOffset.y) {
      return;
    }
    this._zOffset = next;
    this._saveZOffset();
    this._applyZOffsetToRoot();
    this._syncZOffsetNumberUi();
    this._broadcastZOffset();
  }

  _resetZOffset() {
    this._zOffset = this._defaultZOffset();
    this._saveZOffset();
    this._applyZOffsetToRoot();
    this._syncZOffsetToggleUi();
    this._syncZOffsetNumberUi();
    this._broadcastZOffset();
  }

  /** 把当前 z 偏移反映到根元素：class 与 CSS 变量（仅渲染层使用） */
  _applyZOffsetToRoot() {
    const { enabled, x, y } = this._zOffset;
    this.classList.toggle('bp-app--zoffset-on', enabled);
    this.style.setProperty('--bp-zoffset-x', String(x));
    this.style.setProperty('--bp-zoffset-y', String(y));
  }

  _syncZOffsetToggleUi() {
    const checked = this._zOffset.enabled;
    this.querySelectorAll('input[data-role="zoffset-toggle"]').forEach(
      (node) => {
        const el = /** @type {HTMLInputElement} */ (node);
        if (el.checked !== checked) el.checked = checked;
      },
    );
  }

  _syncZOffsetNumberUi() {
    const { x, y } = this._zOffset;
    this.querySelectorAll('input[data-role="zoffset-x"]').forEach((node) => {
      const el = /** @type {HTMLInputElement} */ (node);
      if (document.activeElement !== el && Number(el.value) !== x) {
        el.value = String(x);
      }
    });
    this.querySelectorAll('input[data-role="zoffset-y"]').forEach((node) => {
      const el = /** @type {HTMLInputElement} */ (node);
      if (document.activeElement !== el && Number(el.value) !== y) {
        el.value = String(y);
      }
    });
  }

  /** 把最新偏移广播给已水合的 cell，让其更新棋盘边距 */
  _broadcastZOffset() {
    for (const entry of this._entries) {
      const cell = entry.cellEl;
      if (cell && typeof cell.applyBoardZOffset === 'function') {
        cell.applyBoardZOffset(this._zOffset);
      }
    }
  }

  /** @param {HTMLInputElement} source */
  _onOffsetToggle(source) {
    const enabled = !!source.checked;
    if (enabled === this._offsetEnabled) {
      this._syncOffsetToggleUi();
      return;
    }
    this._offsetEnabled = enabled;
    this._saveOffsetEnabled();
    this._applyOffsetEnabledToRoot();
    this._syncOffsetToggleUi();
    this._broadcastOffsetEnabled();
  }

  /**
   * 把 offset 全局开关反映到根元素：class 与 CSS 数值开关变量。
   *
   * `--bp-offset-on` 在 .bp-tile 的 transform calc 中作为系数（0/1），
   * 关闭时让 offset 项归零、不影响 Z 偏移分量。
   */
  _applyOffsetEnabledToRoot() {
    const enabled = this._offsetEnabled;
    this.classList.toggle('bp-app--offset-on', enabled);
    this.style.setProperty('--bp-offset-on', enabled ? '1' : '0');
  }

  _syncOffsetToggleUi() {
    const checked = this._offsetEnabled;
    this.querySelectorAll('input[data-role="offset-toggle"]').forEach(
      (node) => {
        const el = /** @type {HTMLInputElement} */ (node);
        if (el.checked !== checked) el.checked = checked;
      },
    );
  }

  /**
   * 让每个 cell 知道 offset 全局开关状态——
   * 屏幕渲染由 CSS class/变量驱动无须 JS，但 PNG 导出走 canvas，
   * 必须在 JS 侧明知开关，故依旧广播。
   */
  _broadcastOffsetEnabled() {
    for (const entry of this._entries) {
      const cell = entry.cellEl;
      if (cell && typeof cell.applyOffsetEnabled === 'function') {
        cell.applyOffsetEnabled(this._offsetEnabled);
      }
    }
  }

  /** @param {HTMLInputElement} source */
  _onOffsetUnitPctChange(source) {
    const raw = Number(source.value);
    if (!Number.isFinite(raw)) return;
    const next = this._clampOffsetUnitPct(raw);
    if (next === this._offsetUnitPct) {
      // 即便值没变，也可能是用户输了越界值（如 9）被钳到 5，要回写 UI
      this._syncOffsetUnitPctUi();
      return;
    }
    this._offsetUnitPct = next;
    this._saveOffsetUnitPct();
    this._applyOffsetUnitPctToRoot();
    this._syncOffsetUnitPctUi();
    this._broadcastOffsetUnitPct();
  }

  /**
   * 把 offset 单位缩放系数反映到根元素 CSS 变量 `--bp-offset-unit-pct`。
   *
   * tile 的 transform 在 main.css 中写为：
   *   var(--bp-tile-offset-x) × var(--bp-offset-unit-pct) × 1%
   * 故此变量变化时所有 tile 的视觉偏移**自动重排**，无需重建 DOM。
   * PNG 导出走 canvas，单独通过 _broadcastOffsetUnitPct 同步 JS 状态。
   */
  _applyOffsetUnitPctToRoot() {
    this.style.setProperty('--bp-offset-unit-pct', String(this._offsetUnitPct));
  }

  _syncOffsetUnitPctUi() {
    const value = String(this._offsetUnitPct);
    this.querySelectorAll('input[data-role="offset-unit-pct"]').forEach(
      (node) => {
        const el = /** @type {HTMLInputElement} */ (node);
        if (document.activeElement !== el && el.value !== value) {
          el.value = value;
        }
      },
    );
  }

  /** 广播给每个 cell：PNG 渲染与 board padding 计算需要该数值。 */
  _broadcastOffsetUnitPct() {
    for (const entry of this._entries) {
      const cell = entry.cellEl;
      if (cell && typeof cell.applyOffsetUnitPct === 'function') {
        cell.applyOffsetUnitPct(this._offsetUnitPct);
      }
    }
  }

  /**
   * 在右下角弹出一条轻量 toast；多条并排堆叠，超过 TTL 自动消失。
   * @param {string} message 显示文案
   * @param {{ kind?: 'info' | 'success' | 'warn' | 'error', ttl?: number }} [options]
   */
  _toast(message, options = {}) {
    const text = String(message ?? '').trim();
    if (!text) return;
    const stack = /** @type {HTMLDivElement | null} */ (
      this.querySelector('.bp-app__toast-stack')
    );
    if (!stack) return;
    const kind = options.kind === 'success'
      || options.kind === 'warn'
      || options.kind === 'error'
      ? options.kind
      : 'info';
    const ttl = Number.isFinite(options.ttl) && options.ttl > 0
      ? options.ttl
      : 1800;
    const item = document.createElement('div');
    item.className = `bp-toast bp-toast--${kind}`;
    item.textContent = text;
    stack.appendChild(item);
    // 强制下一帧再加 show，触发 transition
    requestAnimationFrame(() => {
      item.classList.add('bp-toast--show');
    });
    const dismiss = () => {
      if (!item.isConnected) return;
      item.classList.remove('bp-toast--show');
      item.addEventListener(
        'transitionend',
        () => {
          item.remove();
        },
        { once: true },
      );
    };
    window.setTimeout(dismiss, ttl);
  }

  /** @param {HTMLInputElement} source */
  _syncIndexToggles(source) {
    const all = this.querySelectorAll('input[data-role="index-toggle"]');
    all.forEach((cb) => {
      const el = /** @type {HTMLInputElement} */ (cb);
      if (el !== source) el.checked = source.checked;
    });
  }

  _initStickyBar() {
    const sentinel = /** @type {HTMLElement | null} */ (
      this.querySelector('.bp-app__sentinel')
    );
    const sticky = /** @type {HTMLElement | null} */ (
      this.querySelector('.bp-app__sticky')
    );
    if (!sentinel || !sticky) return;
    if (typeof IntersectionObserver === 'undefined') {
      sticky.hidden = false;
      return;
    }
    this._stickyObserver = new IntersectionObserver(
      ([record]) => {
        if (!record) return;
        // sentinel 滚出顶部（rect.top < 0）→ 显示快捷栏
        const above = record.boundingClientRect.top < 0;
        sticky.hidden = !above;
      },
      { root: null, threshold: 0 },
    );
    this._stickyObserver.observe(sentinel);
  }

  _initObserver() {
    if (typeof IntersectionObserver === 'undefined') {
      this._observer = null;
      this._dehydrateObserver = null;
      return;
    }
    // 两个 observer 的两条 rootMargin 形成一个"keep-alive 走廊"：
    //
    //   ┌─── dehydrate buffer (rootMargin: KEEP_ALIVE_PX) ───┐
    //   │   ┌── hydrate buffer (rootMargin: HYDRATE_PX) ──┐  │
    //   │   │              视口 (viewport)                │  │
    //   │   └─────────────────────────────────────────────┘  │
    //   └────────────────────────────────────────────────────┘
    //
    // - 进入 hydrate buffer  → skeleton → cell（水合）
    // - 离开 dehydrate buffer → cell → skeleton（回收）
    //
    // 内圈用来"提前水合，滚到时已就绪"；外圈用来"保留一定缓冲区，避免来回
    // 滚动时反复水合 / 回收"。两圈之间的差值越大、滚动越流畅但内存占用更高。
    this._observer = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          if (!r.isIntersecting) continue;
          const entry = this._entryByEl.get(r.target);
          if (entry && !entry.cellEl) this._hydrateEntry(entry);
        }
      },
      {
        root: null,
        rootMargin: `${BoardPreviewApp.HYDRATE_BUFFER_PX}px 0px`,
        threshold: 0,
      },
    );
    this._dehydrateObserver = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          if (r.isIntersecting) continue;
          const entry = this._entryByEl.get(r.target);
          if (entry && entry.cellEl) this._dehydrateEntry(entry);
        }
      },
      {
        root: null,
        rootMargin: `${BoardPreviewApp.KEEP_ALIVE_BUFFER_PX}px 0px`,
        threshold: 0,
      },
    );
  }

  /**
   * 重置整个预览网格（清空骨架与已水合 cell）
   */
  _resetEntries() {
    for (const e of this._entries) {
      if (e.cellEl) {
        if (this._dehydrateObserver) this._dehydrateObserver.unobserve(e.cellEl);
      } else if (this._observer) {
        this._observer.unobserve(e.el);
      }
    }
    this._entries = [];
    this._entryByEl = new WeakMap();
    this._hydratedCount = 0;
    this._grid.innerHTML = '';
    // 切换 CSV 后，原来的标签使用数据全部失效；筛选状态也应该自然归零。
    if (this._isTagFilterActive()) {
      this._tagFilter.tags.clear();
      this._tagFilter.includeUntagged = false;
      this._applyTagFilter();
      this._syncFilterControls();
    }
    this._renderPredefinedSummary();
    this._renderStatus();
  }

  /**
   * 添加手动新建的预览框（始终水合）
   * @returns {import('./board-preview-cell.js').BoardPreviewCell}
   */
  addCell() {
    const cell = /** @type {import('./board-preview-cell.js').BoardPreviewCell} */ (
      document.createElement('board-preview-cell')
    );
    this._grid.appendChild(cell);
    if (typeof cell.setPredefinedTags === 'function') {
      cell.setPredefinedTags(this._predefinedTags);
    }
    if (typeof cell.applyOffsetEnabled === 'function') {
      cell.applyOffsetEnabled(this._offsetEnabled);
    }
    if (typeof cell.applyOffsetUnitPct === 'function') {
      cell.applyOffsetUnitPct(this._offsetUnitPct);
    }
    this._entries.push({
      kind: 'manual',
      el: cell,
      cellEl: cell,
      item: {},
      originalRow: null,
      csvRow: null,
      index: this._entries.length + 1,
    });
    this._hydratedCount += 1;
    this._refreshSequenceBadges();
    this._renderStatus();
    // 新增 cell 默认 0 标签，需更新「暂无标签 N」统计与按 untagged 已激活的筛选可见性
    this._scheduleSummaryRefresh();
    if (this._isTagFilterActive()) this._applyTagFilter();
    return cell;
  }

  /**
   * 添加来源于导入的懒加载条目；先用骨架占位，进入视口后才创建真正的预览框。
   * @param {object} item
   * @param {string[] | null} originalRow
   * @param {number | null} [csvRow] 1 起的原始 CSV 行号（含表头）
   */
  _addLazyEntry(item, originalRow, csvRow = null) {
    const skeleton = this._createSkeleton(this._entries.length + 1, item, csvRow);
    const entry = {
      kind: /** @type {'csv'} */ ('csv'),
      el: skeleton,
      cellEl: null,
      item,
      originalRow,
      csvRow,
      // 1 起的序号，给 _applySequenceBadge 用，避免 indexOf
      index: this._entries.length + 1,
    };
    this._entryByEl.set(skeleton, entry);
    this._grid.appendChild(skeleton);
    this._entries.push(entry);
    if (this._observer) {
      this._observer.observe(skeleton);
    } else {
      this._hydrateEntry(entry);
    }
    return entry;
  }

  /**
   * 批量添加懒加载条目（用于一次性导入数万条 CSV 行）。
   *
   * 与连续调用 `_addLazyEntry` 相比的关键区别：
   * 1. 一批 skeleton 先 append 到 `DocumentFragment`，一次性挂到 grid，
   *    把同步 reflow 从 N 次降到 1 次/批；
   * 2. 每批之间通过 `requestAnimationFrame` 让出主线程，浏览器可以绘制、
   *    处理用户输入，避免"标签直接卡死/崩溃"；
   * 3. `onProgress(built, total)` 回调用于在 UI 上展示构建进度。
   *
   * 不再每条 `_addLazyEntry` 都触发布局，是支撑 10 万+ 条目的关键路径。
   *
   * @param {Array<{ levelStr: string, slimRow: string[], csvRow: number, tags: string[], offsetStr: string }>} picked
   * @param {(built: number, total: number) => void} [onProgress]
   */
  async _batchAddLazyEntries(picked, onProgress) {
    const BATCH_SIZE = BoardPreviewApp.IMPORT_BATCH_SIZE;
    const total = picked.length;
    let i = 0;
    while (i < total) {
      const end = Math.min(i + BATCH_SIZE, total);
      const frag = document.createDocumentFragment();
      /** @type {Array<{ el: HTMLElement, entry: object }>} */
      const batch = [];
      for (; i < end; i += 1) {
        const p = picked[i];
        const item = {
          tags: p.tags,
          sourceLevelStr: p.levelStr,
          sourceOffsetStr: p.offsetStr,
          operations: [],
          levelStr: p.levelStr,
          offsetStr: p.offsetStr,
          meta: { hadZAxisOperation: false },
        };
        const skeleton = this._createSkeleton(
          this._entries.length + batch.length + 1,
          item,
          p.csvRow,
        );
        const entry = {
          kind: /** @type {'csv'} */ ('csv'),
          el: skeleton,
          cellEl: null,
          item,
          originalRow: p.slimRow,
          csvRow: p.csvRow,
          index: this._entries.length + batch.length + 1,
        };
        frag.appendChild(skeleton);
        batch.push({ el: skeleton, entry });
      }
      this._grid.appendChild(frag);
      for (const { el, entry } of batch) {
        this._entryByEl.set(el, entry);
        this._entries.push(entry);
        if (this._observer) {
          this._observer.observe(el);
        } else {
          this._hydrateEntry(entry);
        }
      }
      onProgress?.(i, total);
      // 让浏览器有机会绘制 / 处理事件，再继续下一批
      await new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 0);
        }
      });
    }
  }

  /**
   * @param {number} seq 1 起的序号
   * @param {object} item
   * @param {number | null} csvRow
   */
  _createSkeleton(seq, item, csvRow) {
    const div = document.createElement('div');
    div.className = 'bp-cell-skeleton';
    const levelStr = String(item?.levelStr ?? '');
    const preview = levelStr.length > 48 ? `${levelStr.slice(0, 48)}…` : levelStr;
    const seqEl = document.createElement('div');
    seqEl.className = 'bp-cell-skeleton__seq';
    seqEl.textContent = csvRow != null ? `#${seq} · CSV 行 ${csvRow}` : `#${seq}`;
    const previewEl = document.createElement('div');
    previewEl.className = 'bp-cell-skeleton__preview';
    previewEl.textContent = preview || '(空关卡串)';
    const hintEl = document.createElement('div');
    hintEl.className = 'bp-cell-skeleton__hint';
    hintEl.textContent = '滚动到此处自动渲染';
    div.append(seqEl, previewEl, hintEl);
    return div;
  }

  /**
   * 把骨架替换为真实预览框；与 {@link _dehydrateEntry} 构成"复用"循环——
   * 滚出 keep-alive 区的 cell 会被回收成 skeleton，回到 hydrate 区时再次水合。
   */
  _hydrateEntry(entry) {
    if (entry.cellEl) return;
    const skeleton = entry.el;
    const cell = /** @type {import('./board-preview-cell.js').BoardPreviewCell} */ (
      document.createElement('board-preview-cell')
    );
    if (this._observer) {
      this._observer.unobserve(skeleton);
    }
    this._entryByEl.delete(skeleton);
    // 把筛选可见性从旧元素带到新元素——否则 dehydrate 一过，被筛选隐藏的
    // 行会"莫名又冒出来"，看上去像筛选失效。
    if (skeleton.hidden) cell.hidden = true;
    skeleton.replaceWith(cell);
    entry.el = cell;
    entry.cellEl = cell;
    this._hydratedCount += 1;
    // 让 dehydrate observer 能从 cell 元素反查到 entry
    this._entryByEl.set(cell, entry);
    if (this._dehydrateObserver) {
      this._dehydrateObserver.observe(cell);
    }
    if (typeof cell.setPredefinedTags === 'function') {
      cell.setPredefinedTags(this._predefinedTags);
    }
    if (typeof cell.applyBoardZOffset === 'function') {
      cell.applyBoardZOffset(this._zOffset);
    }
    if (typeof cell.applyOffsetEnabled === 'function') {
      cell.applyOffsetEnabled(this._offsetEnabled);
    }
    if (typeof cell.applyOffsetUnitPct === 'function') {
      cell.applyOffsetUnitPct(this._offsetUnitPct);
    }
    if (entry.originalRow) {
      cell.setOriginalCsvRow(entry.originalRow);
    }
    cell.loadBundleItem(entry.item);
    this._applySequenceBadge(entry);
    this._scheduleStatusRefresh();
  }

  /**
   * 把已水合的 cell 回收为骨架——支撑十万级 CSV 滚动流畅的关键。
   *
   * 触发时机：cell 离开 dehydrate observer 的 keep-alive 缓冲区。
   *
   * 关键点：
   * - 用 `cell.getExportItem()` 把"用户可能做过的所有编辑"（操作链、当前
   *   levelStr / offsetStr、tags、meta）回写到 `entry.item`；之后 rehydrate
   *   时 `loadBundleItem` 能完全还原。
   * - 焦点保护：若用户正在该 cell 内编辑（焦点在子元素中），跳过本次回收，
   *   等下一帧再判断——否则会无故吞掉编辑焦点。
   * - 状态行 `_renderStatus` 会重新计算"已渲染 X"，让用户感知到回收数量。
   */
  _dehydrateEntry(entry) {
    const cell = entry.cellEl;
    if (!cell) return;
    if (cell.contains(document.activeElement)) return;
    if (typeof cell.getExportItem === 'function') {
      try {
        entry.item = cell.getExportItem();
      } catch {
        // 拿不到当前状态时保留 entry.item 原样——比丢数据安全
      }
    }
    const seqIndex = this._entries.indexOf(entry) + 1;
    const skeleton = this._createSkeleton(seqIndex, entry.item, entry.csvRow);
    // 对称于 _hydrateEntry：cell 被筛选隐藏时，回收后的 skeleton 也必须保持隐藏，
    // 否则隐藏的 cell 在被 dehydrate 之后会重新可见，破坏筛选视图。
    if (cell.hidden) skeleton.hidden = true;
    if (this._dehydrateObserver) this._dehydrateObserver.unobserve(cell);
    this._entryByEl.delete(cell);
    cell.replaceWith(skeleton);
    entry.el = skeleton;
    entry.cellEl = null;
    this._hydratedCount = Math.max(0, this._hydratedCount - 1);
    this._entryByEl.set(skeleton, entry);
    if (this._observer) this._observer.observe(skeleton);
    this._scheduleStatusRefresh();
  }

  /** @param {(typeof this._entries)[number]} entry */
  _applySequenceBadge(entry) {
    if (!entry.cellEl || typeof entry.cellEl.setSequence !== 'function') return;
    // 关键性能修复：避免 indexOf。十万级 entries 时每次 hydrate 触发 O(N) 扫描
    // 会让滚动卡到不可用。`entry.index` 在 push / 重排时维护，hydrate 直接读。
    const index =
      Number.isFinite(entry.index) && entry.index > 0
        ? entry.index
        : this._entries.indexOf(entry) + 1;
    entry.cellEl.setSequence({
      index,
      total: this._entries.length,
      csvRow: entry.csvRow,
    });
  }

  /** 已水合的 cell 重新打位置徽章（条目增删时调用） */
  _refreshSequenceBadges() {
    const total = this._entries.length;
    for (let i = 0; i < total; i++) {
      const e = this._entries[i];
      // 顺手同步 `index` 缓存，让后续单点 hydrate 拿到正确的 seq 号
      e.index = i + 1;
      if (e.cellEl && typeof e.cellEl.setSequence === 'function') {
        e.cellEl.setSequence({ index: i + 1, total, csvRow: e.csvRow });
      }
    }
  }

  /**
   * 把同一帧内多次 hydrate/dehydrate 触发的 status 刷新合并为一次。
   * 十万级 entries 下，逐次刷新会让 visible 计数（O(N) 扫 hidden 属性）反复
   * 跑，把滚动 FPS 拖到个位数。
   */
  _scheduleStatusRefresh() {
    if (this._statusRafId != null) return;
    this._statusRafId = window.requestAnimationFrame(() => {
      this._statusRafId = null;
      this._renderStatus();
    });
  }

  _renderStatus() {
    this._refreshJumpUi();
    const el = /** @type {HTMLDivElement | null} */ (
      this.querySelector('.bp-app__grid-info')
    );
    if (!el) return;
    const total = this._entries.length;
    const hydrated = this._hydratedCount;
    const filterOn = this._isTagFilterActive();
    const visible = filterOn
      ? this._entries.reduce((n, e) => (e.el?.hidden ? n : n + 1), 0)
      : total;
    const segments = [];
    if (total > 0 && total !== hydrated) {
      segments.push(`共 ${total} · 已渲染 ${hydrated}`);
    } else if (total > 0 && filterOn) {
      segments.push(`共 ${total}`);
    }
    if (filterOn) {
      segments.push(`显示 ${visible}`);
    }
    if (!segments.length) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = segments.join(' · ');
  }

  /**
   * 把后续相邻的 bp-cell-change 合并成一次 summary 刷新；
   * 大批量水合 / 解码场景下避免每个 Cell 单独触发全量计数。
   *
   * 同时如果当前筛选激活，则同帧重跑一次 _applyTagFilter——否则用户在
   * 筛选状态下给 cell 加 / 删标签，筛选结果不会实时跟随：刚加上的命中
   * 标签的 cell 仍然 hidden=true，刚撤掉标签的 cell 仍然 hidden=false。
   */
  _scheduleSummaryRefresh() {
    if (this._summaryRafId != null) return;
    this._summaryRafId = window.requestAnimationFrame(() => {
      this._summaryRafId = null;
      this._renderPredefinedSummary();
      if (this._isTagFilterActive()) this._applyTagFilter();
    });
  }

  /**
   * 渲染顶部「预设标签使用统计 + 筛选」chip 行。
   * 数据来源：预设标签 ∪ 任意 entry 用过的标签；按使用数倒序、再按标签名稳定排序。
   */
  _renderPredefinedSummary() {
    const wrap = /** @type {HTMLDivElement | null} */ (
      this.querySelector('[data-role="tag-stats"]')
    );
    if (!wrap) return;
    const counts = countTagUsage(this._entries, this._predefinedTags);
    const seen = new Set(this._predefinedTags);
    const allTags = [...this._predefinedTags];
    for (const key of Object.keys(counts)) {
      if (!seen.has(key)) {
        seen.add(key);
        allTags.push(key);
      }
    }
    allTags.sort((a, b) => {
      const da = counts[a] ?? 0;
      const db = counts[b] ?? 0;
      if (db !== da) return db - da;
      return String(a).localeCompare(String(b), 'zh-Hans-CN');
    });
    const untaggedCount = this._countUntagged();
    wrap.innerHTML = '';
    if (!allTags.length && untaggedCount === 0) {
      const empty = document.createElement('span');
      empty.className = 'bp-app__tag-stats-empty';
      empty.textContent = '暂无标签 — 在上方输入框新增预设后即可使用';
      wrap.appendChild(empty);
      this._syncFilterControls();
      return;
    }
    for (const tag of allTags) {
      const count = counts[tag] ?? 0;
      const isActive = this._tagFilter.tags.has(tag);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bp-chip bp-app__tag-stat';
      if (count === 0) btn.classList.add('bp-app__tag-stat--empty');
      if (isActive) btn.classList.add('bp-app__tag-stat--active');
      btn.setAttribute('role', 'listitem');
      btn.setAttribute('data-action', 'toggle-tag-filter');
      btn.setAttribute('data-tag', tag);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      btn.title = isActive
        ? `当前正按「${tag}」筛选（点击取消）`
        : `按「${tag}」筛选（当前使用：${count}）`;
      btn.style.setProperty('--chip-h', String(tagHue(tag)));
      const label = document.createElement('span');
      label.className = 'bp-chip__label';
      label.textContent = tag;
      const cnt = document.createElement('span');
      cnt.className = 'bp-app__tag-stat-count';
      cnt.textContent = String(count);
      btn.appendChild(label);
      btn.appendChild(cnt);
      wrap.appendChild(btn);
    }
    // 「暂无标签」虚拟 chip：仅当真的存在 0-tag cell 时渲染；和具体标签解耦，不参与色相哈希
    if (untaggedCount > 0) {
      const isOn = this._tagFilter.includeUntagged;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bp-chip bp-app__tag-stat bp-app__tag-stat--untagged';
      if (isOn) btn.classList.add('bp-app__tag-stat--active');
      btn.setAttribute('role', 'listitem');
      btn.setAttribute('data-action', 'toggle-untagged-filter');
      btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      btn.title = isOn
        ? '当前正在显示「未打标签」的预览框（点击取消）'
        : `按「未打标签」筛选（当前未打标签：${untaggedCount}）`;
      const label = document.createElement('span');
      label.className = 'bp-chip__label';
      label.textContent = '暂无标签';
      const cnt = document.createElement('span');
      cnt.className = 'bp-app__tag-stat-count';
      cnt.textContent = String(untaggedCount);
      btn.appendChild(label);
      btn.appendChild(cnt);
      wrap.appendChild(btn);
    }
    this._syncFilterControls();
  }

  /** 统计当前没有任何标签的 entry 数量；兼顾已水合与未水合两种状态。 */
  _countUntagged() {
    let n = 0;
    for (const e of this._entries) {
      if (readEntryTags(e).length === 0) n++;
    }
    return n;
  }

  /** 是否处于任何标签筛选状态（含「无标签」虚拟筛选） */
  _isTagFilterActive() {
    return this._tagFilter.tags.size > 0 || this._tagFilter.includeUntagged;
  }

  /** @param {string | undefined} tag */
  _toggleTagFilter(tag) {
    if (!tag) return;
    if (this._tagFilter.tags.has(tag)) {
      this._tagFilter.tags.delete(tag);
    } else {
      this._tagFilter.tags.add(tag);
    }
    this._applyTagFilter();
    this._renderPredefinedSummary();
    this._renderStatus();
  }

  _toggleUntaggedFilter() {
    this._tagFilter.includeUntagged = !this._tagFilter.includeUntagged;
    this._applyTagFilter();
    this._renderPredefinedSummary();
    this._renderStatus();
  }

  _toggleFilterMode() {
    this._tagFilter.mode = this._tagFilter.mode === 'or' ? 'and' : 'or';
    this._applyTagFilter();
    this._syncFilterControls();
    this._renderStatus();
  }

  _clearTagFilter() {
    if (!this._isTagFilterActive()) return;
    this._tagFilter.tags.clear();
    this._tagFilter.includeUntagged = false;
    this._applyTagFilter();
    this._renderPredefinedSummary();
    this._renderStatus();
  }

  /**
   * 把当前 _tagFilter 应用到每个 entry：命中 -> 显示，未命中 -> el.hidden = true。
   * 隐藏的 entry 不会进入视口，IntersectionObserver 自然不会触发水合；
   * 已水合的 Cell 不被卸载，保留用户编辑。
   *
   * 组合规则：
   * - OR 模式：(任一 tag 命中) ∪ (includeUntagged ? 无标签 : ∅)
   * - AND 模式：(全部 tag 命中) ∩ (includeUntagged ? 无标签 : 全集)
   *   注：AND 下同时勾选具体标签与「无标签」语义为空集（互斥），不再警告
   */
  _applyTagFilter() {
    const active = this._tagFilter.tags;
    const includeUntagged = this._tagFilter.includeUntagged;
    const hasFilter = active.size > 0 || includeUntagged;
    this.classList.toggle('bp-app--filter-on', hasFilter);
    if (!hasFilter) {
      for (const e of this._entries) {
        if (e?.el) e.el.hidden = false;
      }
      return;
    }
    const mode = this._tagFilter.mode;
    /** @type {Parameters<typeof matchTagFilter>[1] | null} */
    const filter = active.size === 0
      ? null
      : mode === 'and'
        ? { all: [...active] }
        : { any: [...active] };
    for (const e of this._entries) {
      if (!e?.el) continue;
      const tags = readEntryTags(e);
      const tagHit = filter ? matchTagFilter(tags, filter) : false;
      const untaggedHit = includeUntagged && tags.length === 0;
      let visible;
      if (mode === 'and') {
        const passTags = filter ? tagHit : true;
        const passUntagged = includeUntagged ? untaggedHit : true;
        visible = passTags && passUntagged;
      } else {
        visible = tagHit || untaggedHit;
      }
      e.el.hidden = !visible;
    }
  }

  /** 刷新 OR/AND 切换按钮文案、清空按钮可见性。 */
  _syncFilterControls() {
    const modeBtn = /** @type {HTMLButtonElement | null} */ (
      this.querySelector('button[data-action="toggle-filter-mode"]')
    );
    if (modeBtn) {
      const isAnd = this._tagFilter.mode === 'and';
      modeBtn.textContent = isAnd ? 'AND' : 'OR';
      modeBtn.setAttribute('aria-pressed', isAnd ? 'true' : 'false');
      modeBtn.title = isAnd
        ? 'AND：必须包含全部已选标签才显示该预览框（点击切换为 OR）'
        : 'OR：任一已选标签命中即显示该预览框（点击切换为 AND）';
    }
    const clearBtn = /** @type {HTMLButtonElement | null} */ (
      this.querySelector('button[data-action="clear-tag-filter"]')
    );
    if (clearBtn) {
      clearBtn.hidden = !this._isTagFilterActive();
    }
  }

  /** 同步所有跳转组的总数显示、输入框 max 上限与禁用状态 */
  _refreshJumpUi() {
    const total = this._entries.length;
    this.querySelectorAll('[data-role="jump-total"]').forEach((el) => {
      el.textContent = `/ ${total}`;
    });
    this.querySelectorAll('input[data-role="jump-input"]').forEach((node) => {
      const input = /** @type {HTMLInputElement} */ (node);
      if (total > 0) {
        input.max = String(total);
        input.disabled = false;
      } else {
        input.removeAttribute('max');
        input.disabled = true;
        input.value = '';
      }
    });
    this.querySelectorAll('button[data-action="jump-to"]').forEach((node) => {
      const btn = /** @type {HTMLButtonElement} */ (node);
      btn.disabled = total === 0;
    });
  }

  /**
   * 从触发源（按钮或输入框）所在的跳转组里取序号并跳转。
   * @param {HTMLElement | null} source
   */
  _jumpFromInput(source) {
    const group = source?.closest?.('.bp-jump') ?? this.querySelector('.bp-jump');
    const input = /** @type {HTMLInputElement | null} */ (
      group?.querySelector('input[data-role="jump-input"]') ?? null
    );
    if (!input) return;
    const raw = input.value.trim();
    const total = this._entries.length;
    if (!raw) {
      this._reportJumpError(input, '请输入要跳转到的序号');
      return;
    }
    const seq = Number.parseInt(raw, 10);
    if (!Number.isFinite(seq) || !Number.isInteger(seq)) {
      this._reportJumpError(input, '请输入有效的整数序号');
      return;
    }
    if (total === 0) {
      this._reportJumpError(input, '当前没有任何预览框');
      return;
    }
    if (seq < 1 || seq > total) {
      this._reportJumpError(input, `请输入 1 到 ${total} 之间的序号`);
      return;
    }
    this.jumpTo(seq);
  }

  /**
   * @param {HTMLInputElement} input
   * @param {string} message
   */
  _reportJumpError(input, message) {
    input.classList.remove('bp-jump__input--err');
    void input.offsetWidth;
    input.classList.add('bp-jump__input--err');
    input.title = message;
    input.focus({ preventScroll: true });
    input.select();
    window.setTimeout(() => {
      input.classList.remove('bp-jump__input--err');
      input.title = '';
    }, 1200);
  }

  /**
   * 跳转到第 seq 条预览框（1 起），尽量将其滚动到视口中央。
   *
   * 关键：骨架与真实 cell 的高度不同。若 smooth scroll 过程中懒加载
   * Observer 把目标之前的骨架水合，前置元素会"长高"，把目标 cell 往下挤，
   * 导致最终位置严重偏离视口中央。
   *
   * 这里采取「暂停懒加载 → 仅水合目标本身 → 滚动 → 等动画完成再恢复
   * 懒加载」的策略：滚动期间布局完全冻结，目标 cell 在 DOM 中的实际位置
   * 等于其骨架占位的位置，scrollIntoView 能精确落到视口中央。
   * @param {number} seq
   */
  jumpTo(seq) {
    const total = this._entries.length;
    if (!Number.isInteger(seq) || seq < 1 || seq > total) return;
    const entry = this._entries[seq - 1];
    if (!entry) return;

    if (entry.el?.hidden) {
      this._toast(
        `#${seq} 被当前标签筛选隐藏，已自动暂停筛选以跳转到该条`,
        { kind: 'info', ttl: 3500 },
      );
      this._clearTagFilter();
    }

    this._suspendLazyHydration();

    const justHydrated = !entry.cellEl;
    if (justHydrated) this._hydrateEntry(entry);

    const scrollAndFlash = () => {
      const target = /** @type {HTMLElement | null} */ (entry.el);
      if (!target?.scrollIntoView) {
        this._resumeLazyHydration();
        return;
      }
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      this._flashTarget(target);
      // 滚动动画约 300~600ms，留出余量后再恢复懒加载
      this._scheduleResumeLazyHydration(800);
    };

    if (justHydrated) {
      requestAnimationFrame(() => requestAnimationFrame(scrollAndFlash));
    } else {
      requestAnimationFrame(scrollAndFlash);
    }
  }

  /** 暂停懒加载 Observer，防止跳转期间布局被骨架水合扰动 */
  _suspendLazyHydration() {
    if (this._resumeHydrationTimer != null) {
      window.clearTimeout(this._resumeHydrationTimer);
      this._resumeHydrationTimer = null;
    }
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    if (this._dehydrateObserver) {
      this._dehydrateObserver.disconnect();
      this._dehydrateObserver = null;
    }
  }

  /** @param {number} delayMs */
  _scheduleResumeLazyHydration(delayMs) {
    if (this._resumeHydrationTimer != null) {
      window.clearTimeout(this._resumeHydrationTimer);
    }
    this._resumeHydrationTimer = window.setTimeout(() => {
      this._resumeHydrationTimer = null;
      this._resumeLazyHydration();
    }, delayMs);
  }

  /** 重新启用懒加载，并把当前所有未水合骨架重新挂上 Observer */
  _resumeLazyHydration() {
    if (this._observer) return;
    this._initObserver();
    if (!this._observer) return;
    for (const e of this._entries) {
      if (e.cellEl) {
        if (this._dehydrateObserver) this._dehydrateObserver.observe(e.cellEl);
      } else {
        this._observer.observe(e.el);
      }
    }
  }

  /** @param {HTMLElement} target */
  _flashTarget(target) {
    target.classList.remove('bp-jump-flash');
    // 触发重绘，确保动画能重启
    void target.offsetWidth;
    target.classList.add('bp-jump-flash');
    window.setTimeout(() => {
      target.classList.remove('bp-jump-flash');
    }, 1500);
  }

  _broadcastPredefinedTags() {
    for (const e of this._entries) {
      const cell = e.cellEl;
      if (cell && typeof cell.setPredefinedTags === 'function') {
        cell.setPredefinedTags(this._predefinedTags);
      }
    }
    // 用户改预设标签后，统计行需要立即重排；
    // 若已激活的筛选项中含被删除的标签，则把它一并从激活集合移除（与 D1 软保留协同）。
    let filterChanged = false;
    for (const t of [...this._tagFilter.tags]) {
      if (!this._predefinedTags.includes(t)) {
        this._tagFilter.tags.delete(t);
        filterChanged = true;
      }
    }
    if (filterChanged) {
      this._applyTagFilter();
      this._renderStatus();
    }
    this._renderPredefinedSummary();
  }

  /**
   * 当前所有条目的「有效」内容：已水合的取自 cell，未水合的用导入快照。
   * @returns {Array<{ originalRow: string[] | null, item: object }>}
   */
  _effectiveEntries() {
    return this._entries.map((e) => {
      if (e.cellEl) {
        return {
          originalRow: e.cellEl.getOriginalCsvRow(),
          item: e.cellEl.getExportItem(),
        };
      }
      return {
        originalRow: e.originalRow ? [...e.originalRow] : null,
        item: { ...e.item },
      };
    });
  }

  /** @returns {import('../io/csv.js').ExportEntry[]} */
  _exportEntries() {
    return this._effectiveEntries();
  }

  _csvExportWithIndex() {
    const cb = /** @type {HTMLInputElement | null} */ (
      this.querySelector('.bp-csv-export-index')
    );
    return Boolean(cb?.checked);
  }

  /**
   * 把所有导出共用的 serializeExportCsv 选项整理为一处，避免多处调用点遗漏 `tagsColumnIndex` / `offsetColumnIndex`。
   * @param {import('../io/csv.js').ExportEntry[]} entries
   * @returns {import('../io/csv.js').ExportCsvOptions}
   */
  _buildExportCsvOptions(entries) {
    return {
      header: this._csvHeader,
      originalColumnCount: this._csvColumnCount,
      entries,
      operatorOf: operationsToGlyphString,
      tagsOf: (item) => item?.tags ?? [],
      tagsColumnIndex: this._csvTagsColumnIndex,
      offsetOf: (item) => item?.offsetStr ?? '',
      offsetColumnIndex: this._csvOffsetColumnIndex,
      sourceOffsetOf: (item) => item?.sourceOffsetStr ?? '',
      targetOffsetOf: (item) => item?.offsetStr ?? '',
      withIndex: this._csvExportWithIndex(),
    };
  }

  exportCsvAll() {
    const entries = this._exportEntries();
    if (!entries.length) {
      this._toast('没有可导出的预览框。', { kind: 'warn' });
      return;
    }
    const csv = serializeExportCsv(this._buildExportCsvOptions(entries));
    downloadTextFile(csv, 'board-preview-export.csv', 'text/csv;charset=utf-8');
    this._toast(`已导出 ${entries.length} 条到 CSV`, { kind: 'success' });
  }

  /**
   * 打开「按标签导出 CSV」多选浮层。
   * 浮层位于 `<bp-app>` 之下、与所有 Cell 平级，使用 fixed 定位脱离文档流。
   */
  _openExportTagModal() {
    if (this._exportTagModal) return;
    if (!this._entries.length) {
      this._toast('当前没有可导出的预览框。', { kind: 'warn' });
      return;
    }
    const tags = this._collectExportModalTagPool();
    if (!tags.length) {
      this._toast('当前所有预览框都没有标签。', { kind: 'warn' });
      return;
    }
    const root = document.createElement('div');
    root.className = 'bp-export-modal';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '按标签导出 CSV');
    root.innerHTML = `
      <div class="bp-export-modal__backdrop" data-action="export-tag-modal-cancel"></div>
      <div class="bp-export-modal__card" role="document">
        <header class="bp-export-modal__hdr">
          <h3 class="bp-export-modal__title">按标签导出 CSV</h3>
          <button
            type="button"
            class="bp-export-modal__close"
            data-action="export-tag-modal-close"
            aria-label="关闭"
          >×</button>
        </header>
        <div class="bp-export-modal__body">
          <div class="bp-export-modal__ctrl">
            <span class="bp-export-modal__ctrl-label">匹配模式</span>
            <button
              type="button"
              class="bp-btn bp-btn--sm"
              data-action="export-tag-modal-toggle-mode"
              data-role="export-mode"
            >OR</button>
            <span class="bp-export-modal__hint" data-role="export-mode-hint"></span>
            <span class="bp-export-modal__spacer"></span>
            <button
              type="button"
              class="bp-btn bp-btn--sm"
              data-action="export-tag-modal-clear"
              data-role="export-clear"
              hidden
            >清空所选</button>
          </div>
          <div class="bp-export-modal__chips" role="list" data-role="export-chips"></div>
          <div class="bp-export-modal__summary" data-role="export-summary"></div>
        </div>
        <footer class="bp-export-modal__ftr">
          <button
            type="button"
            class="bp-btn"
            data-action="export-tag-modal-cancel"
          >取消</button>
          <button
            type="button"
            class="bp-btn bp-btn--primary"
            data-action="export-tag-modal-confirm"
            data-role="export-confirm"
            disabled
          >导出 0 条</button>
        </footer>
      </div>
    `;
    // 必须挂在 `<bp-app>` 内部，否则委托式 click 监听（this.addEventListener）收不到。
    this.appendChild(root);
    this._exportTagModal = {
      tags: new Set(),
      mode: 'or',
      root,
    };
    document.addEventListener('keydown', this._onExportTagModalKey);
    this._renderExportTagModal();
    // 把焦点送到第一个 chip 或关闭按钮，便于键盘用户
    const firstChip = /** @type {HTMLElement | null} */ (
      root.querySelector('[data-action="export-tag-modal-toggle-tag"]')
    );
    (firstChip ?? root.querySelector('[data-action="export-tag-modal-close"]'))
      ?.focus?.();
  }

  _closeExportTagModal() {
    const state = this._exportTagModal;
    if (!state) return;
    document.removeEventListener('keydown', this._onExportTagModalKey);
    state.root.remove();
    this._exportTagModal = null;
  }

  /**
   * 浮层渲染：标签 chip 列表 + 计数 + 命中预览 + 模式按钮 + 确认按钮 disabled 状态。
   */
  _renderExportTagModal() {
    const state = this._exportTagModal;
    if (!state) return;
    const root = state.root;
    const counts = countTagUsage(this._entries, this._predefinedTags);
    const tags = this._collectExportModalTagPool(counts);

    const chipsWrap = /** @type {HTMLElement | null} */ (
      root.querySelector('[data-role="export-chips"]')
    );
    if (chipsWrap) {
      chipsWrap.innerHTML = '';
      for (const tag of tags) {
        const count = counts[tag] ?? 0;
        const isOn = state.tags.has(tag);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bp-chip bp-app__tag-stat';
        if (count === 0) btn.classList.add('bp-app__tag-stat--empty');
        if (isOn) btn.classList.add('bp-app__tag-stat--active');
        btn.setAttribute('role', 'listitem');
        btn.setAttribute('data-action', 'export-tag-modal-toggle-tag');
        btn.setAttribute('data-tag', tag);
        btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
        btn.style.setProperty('--chip-h', String(tagHue(tag)));
        const label = document.createElement('span');
        label.className = 'bp-chip__label';
        label.textContent = tag;
        const cnt = document.createElement('span');
        cnt.className = 'bp-app__tag-stat-count';
        cnt.textContent = String(count);
        btn.appendChild(label);
        btn.appendChild(cnt);
        chipsWrap.appendChild(btn);
      }
    }

    const modeBtn = /** @type {HTMLButtonElement | null} */ (
      root.querySelector('[data-role="export-mode"]')
    );
    const modeHint = /** @type {HTMLElement | null} */ (
      root.querySelector('[data-role="export-mode-hint"]')
    );
    if (modeBtn) {
      const isAnd = state.mode === 'and';
      modeBtn.textContent = isAnd ? 'AND' : 'OR';
      modeBtn.setAttribute('aria-pressed', isAnd ? 'true' : 'false');
    }
    if (modeHint) {
      modeHint.textContent =
        state.mode === 'and'
          ? '导出同时包含全部已选标签的预览框'
          : '导出包含任意一个已选标签的预览框';
    }

    const clearBtn = /** @type {HTMLButtonElement | null} */ (
      root.querySelector('[data-role="export-clear"]')
    );
    if (clearBtn) clearBtn.hidden = state.tags.size === 0;

    const hits = this._computeExportTagHits();
    const summary = /** @type {HTMLElement | null} */ (
      root.querySelector('[data-role="export-summary"]')
    );
    if (summary) {
      if (state.tags.size === 0) {
        summary.textContent = '请至少选择一个标签';
      } else {
        summary.textContent = `命中 ${hits.length} / ${this._entries.length} 条`;
      }
    }

    const confirmBtn = /** @type {HTMLButtonElement | null} */ (
      root.querySelector('[data-role="export-confirm"]')
    );
    if (confirmBtn) {
      confirmBtn.disabled = hits.length === 0;
      confirmBtn.textContent = `导出 ${hits.length} 条`;
    }
  }

  /**
   * 浮层使用的标签池：预设标签 ∪ 任何 entry 用过的标签，按使用数倒序、再按标签名稳定排序。
   * @param {Record<string, number>} [counts]
   * @returns {string[]}
   */
  _collectExportModalTagPool(counts) {
    const c = counts ?? countTagUsage(this._entries, this._predefinedTags);
    const seen = new Set();
    const pool = [];
    for (const t of this._predefinedTags) {
      if (!seen.has(t)) {
        seen.add(t);
        pool.push(t);
      }
    }
    for (const t of Object.keys(c)) {
      if (!seen.has(t)) {
        seen.add(t);
        pool.push(t);
      }
    }
    pool.sort((a, b) => {
      const da = c[a] ?? 0;
      const db = c[b] ?? 0;
      if (db !== da) return db - da;
      return String(a).localeCompare(String(b), 'zh-Hans-CN');
    });
    return pool;
  }

  /** 计算当前浮层选中标签下命中的 entry（完整态，不受 C2 筛选影响）。 */
  _computeExportTagHits() {
    const state = this._exportTagModal;
    if (!state || state.tags.size === 0) return [];
    const filter =
      state.mode === 'and'
        ? { all: [...state.tags] }
        : { any: [...state.tags] };
    return this._exportEntries().filter((e) =>
      matchTagFilter(e.item.tags ?? [], filter),
    );
  }

  /** @param {string | undefined} tag */
  _toggleExportModalTag(tag) {
    const state = this._exportTagModal;
    if (!state || !tag) return;
    if (state.tags.has(tag)) state.tags.delete(tag);
    else state.tags.add(tag);
    this._renderExportTagModal();
  }

  _toggleExportModalMode() {
    const state = this._exportTagModal;
    if (!state) return;
    state.mode = state.mode === 'or' ? 'and' : 'or';
    this._renderExportTagModal();
  }

  _clearExportModalSelection() {
    const state = this._exportTagModal;
    if (!state || state.tags.size === 0) return;
    state.tags.clear();
    this._renderExportTagModal();
  }

  _confirmExportTagModal() {
    const state = this._exportTagModal;
    if (!state || state.tags.size === 0) return;
    const entries = this._computeExportTagHits();
    if (!entries.length) {
      this._toast('当前条件命中 0 条，未导出。', { kind: 'warn' });
      return;
    }
    const csv = serializeExportCsv(this._buildExportCsvOptions(entries));
    downloadTextFile(
      csv,
      this._buildExportTagFilename(state),
      'text/csv;charset=utf-8',
    );
    const tagsText = [...state.tags].map((t) => `「${t}」`).join(state.mode === 'and' ? ' & ' : ' / ');
    this._toast(
      `已按 ${tagsText} 导出 ${entries.length} 条到 CSV`,
      { kind: 'success' },
    );
    this._closeExportTagModal();
  }

  /**
   * 文件名按 [multi-tag-export.md §4.2] 决定：≤3 个 tag 时拼接；否则用 <n>cond 兜底。
   * 同时把文件名中的非法字符（`/`、空格、引号等）替换为 `_`，避免下载 API 拒绝。
   *
   * @param {{ tags: Set<string>, mode: 'or' | 'and' }} state
   * @returns {string}
   */
  _buildExportTagFilename(state) {
    const sanitize = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_');
    const list = [...state.tags];
    if (list.length <= 3) {
      return `board-preview-tags-${list.map(sanitize).join('-')}.csv`;
    }
    return `board-preview-tags-${list.length}cond.csv`;
  }

  exportCsvByTag() {
    const tag = window.prompt('要包含的标签（任一匹配即导出该预览框）:', '');
    if (tag === null) return;
    const needle = tag.trim();
    if (!needle) {
      this._toast('未输入标签。', { kind: 'warn' });
      return;
    }
    const entries = this._exportEntries().filter((e) =>
      e.item.tags.some((t) => t.includes(needle)),
    );
    if (!entries.length) {
      this._toast(`没有带「${needle}」标签的预览框。`, { kind: 'warn' });
      return;
    }
    const csv = serializeExportCsv(this._buildExportCsvOptions(entries));
    downloadTextFile(csv, `board-preview-${needle}.csv`, 'text/csv;charset=utf-8');
    this._toast(
      `已按「${needle}」导出 ${entries.length} 条到 CSV`,
      { kind: 'success' },
    );
  }

  /** @param {HTMLInputElement} input */
  async _onCsvFileChosen(input) {
    const file = input.files?.[0];
    input.value = '';
    await this._loadCsvFromFile(file);
  }

  /**
   * dragover/drop 事件路径上判断载荷是否是文件。
   * dragover 阶段 `dataTransfer.files` 是 0（浏览器安全限制），
   * 只能查 `types` 数组里有没有 'Files'。
   *
   * @param {DragEvent} e
   * @returns {boolean}
   */
  _isFileDrag(e) {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types).includes('Files');
  }

  /** @param {DragEvent} e */
  _onAppDragEnter(e) {
    if (!this._isFileDrag(e)) return;
    e.preventDefault();
    this._dragCounter++;
    this.classList.add('bp-app--dragover');
  }

  /** @param {DragEvent} e */
  _onAppDragOver(e) {
    if (!this._isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  /** @param {DragEvent} e */
  _onAppDragLeave(e) {
    if (!this._isFileDrag(e)) return;
    e.preventDefault();
    this._dragCounter = Math.max(0, this._dragCounter - 1);
    if (this._dragCounter === 0) {
      this.classList.remove('bp-app--dragover');
    }
  }

  /** @param {DragEvent} e */
  _onAppDrop(e) {
    if (!this._isFileDrag(e)) return;
    e.preventDefault();
    this._dragCounter = 0;
    this.classList.remove('bp-app--dragover');
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    const csvFile = files.find(
      (f) => /\.csv$/i.test(f.name) || f.type === 'text/csv',
    );
    if (!csvFile) {
      const names = files.map((f) => f.name).join('、');
      this._toast(`仅支持 .csv 文件（收到：${names}）`, {
        kind: 'warn',
        ttl: 4000,
      });
      return;
    }
    if (files.length > 1) {
      this._toast(
        `已拖入 ${files.length} 个文件，仅采用第一个 CSV：${csvFile.name}`,
        { kind: 'info' },
      );
    }
    this._loadCsvFromFile(csvFile);
  }

  /**
   * 把一个 File 读为 CSV、写入 `_pendingCsv` 并展开列选择面板。
   * 文件输入 + 拖拽导入两条路径共用，确保两种来源行为完全一致。
   *
   * @param {File | undefined | null} file
   */
  async _loadCsvFromFile(file) {
    if (!file) return;
    try {
      // 改成流式只读首行：避免对 600 MB 量级 CSV 调用 FileReader.readAsText
      // 直接把整个文本塞进单个字符串——这会触发 V8 OOM 或静默返回空，
      // 表现为"CSV 为空或无法解析"的假阳性。真正的全文件扫描推迟到
      // "确认导入"时再做（届时只保留必要的列到内存）。
      const firstRow = await readCsvFirstRow(file);
      if (!firstRow.length) {
        window.alert('CSV 为空或无法解析（未读到任何字段）。');
        return;
      }
      this._pendingCsv = { file, fileName: file.name, firstRow };
      // 选了新文件 → 旧的「已导入」状态作废；下次确认导入才会重新置位
      this._csvImported = false;
      const panel = /** @type {HTMLDivElement} */ (
        this.querySelector('.bp-csv-confirm')
      );
      const nameEl = this.querySelector('.bp-csv-confirm__name');
      if (nameEl) {
        const sizeMb = file.size / (1024 * 1024);
        const sizeText =
          sizeMb >= 1 ? `${sizeMb.toFixed(1)} MB` : `${Math.round(file.size / 1024)} KB`;
        nameEl.textContent = `已选择：${file.name}（${sizeText}）`;
      }
      this._populateCsvColumnSelect();
      if (panel) {
        panel.hidden = false;
        // 拖拽场景下用户没主动滚动到导入区，给一次平滑滚动便于继续操作
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.alert(`读取 CSV 失败：${msg}`);
    }
  }

  _populateCsvColumnSelect() {
    const sel = /** @type {HTMLSelectElement | null} */ (
      this.querySelector('.bp-csv-column-select')
    );
    const tagsSel = /** @type {HTMLSelectElement | null} */ (
      this.querySelector('.bp-csv-tags-select')
    );
    const offsetSel = /** @type {HTMLSelectElement | null} */ (
      this.querySelector('.bp-csv-offset-select')
    );
    const headerEl = /** @type {HTMLInputElement | null} */ (
      this.querySelector('.bp-csv-header')
    );
    if (!sel || !this._pendingCsv) return;

    const { firstRow } = this._pendingCsv;
    const firstRowIsHeader = Boolean(headerEl?.checked);
    // 流式路径下我们只持有首行；其他行的"最大列数"在确认导入时才精确知道。
    // 列选择面板用首行长度作为列数估计，足够覆盖 99% 的真实 CSV（表头列数
    // 通常就是最宽行）。若实际数据某行更宽，确认导入时会按真实列数采样，
    // 不影响目标列的提取。
    const colCount = firstRow.length;
    /** @type {string[]} */
    const labels = firstRowIsHeader
      ? Array.from({ length: colCount }, (_, i) => {
          const t = (firstRow[i] ?? '').trim();
          return t || `列${i}`;
        })
      : Array.from({ length: colCount }, (_, i) => `列 ${i}`);
    sel.innerHTML = '';
    for (let i = 0; i < labels.length; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${labels[i]}（列 ${i}）`;
      sel.appendChild(opt);
    }
    sel.disabled = labels.length === 0;

    const matchAgainst = firstRowIsHeader
      ? Array.from({ length: colCount }, (_, i) =>
          (firstRow[i] ?? '').trim(),
        )
      : labels;
    sel.value = String(defaultContentColumnIndex(matchAgainst));

    /**
     * 填充一个"可选列"下拉：第一项为「无」(value="-1")，其余为各列。
     * @param {HTMLSelectElement | null} target
     * @param {number} defaultIdx
     * @param {string} noneLabel
     */
    const populateOptional = (target, defaultIdx, noneLabel) => {
      if (!target) return;
      target.innerHTML = '';
      const noneOpt = document.createElement('option');
      noneOpt.value = '-1';
      noneOpt.textContent = noneLabel;
      target.appendChild(noneOpt);
      for (let i = 0; i < labels.length; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `${labels[i]}（列 ${i}）`;
        target.appendChild(opt);
      }
      target.disabled = labels.length === 0;
      target.value = String(defaultIdx);
    };
    populateOptional(
      tagsSel,
      defaultTagsColumnIndex(matchAgainst),
      '无（不导入标签）',
    );
    populateOptional(
      offsetSel,
      defaultOffsetColumnIndex(matchAgainst),
      '无（不导入 offset）',
    );
  }

  async _confirmCsvImport() {
    if (!this._pendingCsv) {
      window.alert('请先选择 CSV 文件。');
      return;
    }
    const sel = /** @type {HTMLSelectElement | null} */ (
      this.querySelector('.bp-csv-column-select')
    );
    const tagsSel = /** @type {HTMLSelectElement | null} */ (
      this.querySelector('.bp-csv-tags-select')
    );
    const offsetSel = /** @type {HTMLSelectElement | null} */ (
      this.querySelector('.bp-csv-offset-select')
    );
    const headerEl = /** @type {HTMLInputElement | null} */ (
      this.querySelector('.bp-csv-header')
    );
    if (!sel || sel.disabled) {
      window.alert('没有可选列。');
      return;
    }
    const colIndex = Number.parseInt(sel.value, 10);
    if (Number.isNaN(colIndex) || colIndex < 0) {
      window.alert('请选择有效列。');
      return;
    }
    /** @param {HTMLSelectElement | null} target */
    const parseOptionalIdx = (target) => {
      if (!target) return null;
      const raw = Number.parseInt(target.value, 10);
      return Number.isInteger(raw) && raw >= 0 ? raw : null;
    };
    const tagsColIndex = parseOptionalIdx(tagsSel);
    const offsetColIndex = parseOptionalIdx(offsetSel);
    if (tagsColIndex !== null && tagsColIndex === colIndex) {
      window.alert('「标签所在列」不能与「关卡串所在列」相同，请重新选择。');
      return;
    }
    if (offsetColIndex !== null && offsetColIndex === colIndex) {
      window.alert('「Offset 所在列」不能与「关卡串所在列」相同，请重新选择。');
      return;
    }
    if (
      offsetColIndex !== null &&
      tagsColIndex !== null &&
      offsetColIndex === tagsColIndex
    ) {
      window.alert('「Offset 所在列」不能与「标签所在列」相同，请重新选择。');
      return;
    }
    const firstRowIsHeader = Boolean(headerEl?.checked);
    const { file, firstRow } = this._pendingCsv;
    const totalBytes = file.size;
    // 把确认按钮置为 loading 状态，防止用户重复点击触发并发流式扫
    const confirmBtn = /** @type {HTMLButtonElement | null} */ (
      this.querySelector('[data-action="confirm-csv-import"]')
    );
    const cancelBtn = /** @type {HTMLButtonElement | null} */ (
      this.querySelector('[data-action="cancel-csv-import"]')
    );
    const progressEl = /** @type {HTMLSpanElement | null} */ (
      this.querySelector('.bp-csv-confirm__progress')
    );
    if (this._csvImporting) return;
    this._csvImporting = true;
    const prevConfirmText = confirmBtn?.textContent ?? '';
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = '正在导入…';
    }
    if (cancelBtn) cancelBtn.disabled = true;
    if (progressEl) {
      progressEl.hidden = false;
      progressEl.textContent = '正在扫描 0%…';
    }
    // 内存"瘦身策略"：行字符串只保留**用户选中的几列**（关卡串 / 标签 / Offset），
    // 其他列丢弃。原因：600 MB CSV 全字段保留 ≈ 1.2 GB UTF-16 heap，Chrome
    // 会在解析后期 OOM / GC 抖动 / 主线程冻结。这里牺牲"导出时保留全部原列"的
    // 能力换稳定性，并在事后用 toast 明确告知用户。
    /** @type {Array<{ levelStr: string, slimRow: string[], csvRow: number, tags: string[], offsetStr: string }>} */
    const picked = [];
    let columnCount = firstRow.length;
    let lastProgressUpdate = 0;
    // slimRow 中"未选中列"统一指向同一个 '' 单例，避免 119k × N 个独立空字符串分配
    const EMPTY = '';
    /** @param {string[]} row */
    const buildSlimRow = (row) => {
      const len = row.length;
      const slim = new Array(len);
      for (let i = 0; i < len; i += 1) slim[i] = EMPTY;
      slim[colIndex] = row[colIndex] ?? EMPTY;
      if (tagsColIndex !== null && len > tagsColIndex) {
        slim[tagsColIndex] = row[tagsColIndex] ?? EMPTY;
      }
      if (offsetColIndex !== null && len > offsetColIndex) {
        slim[offsetColIndex] = row[offsetColIndex] ?? EMPTY;
      }
      return slim;
    };
    try {
      await streamParseCsvFile(
        file,
        (row, rowIndex) => {
          if (row.length > columnCount) columnCount = row.length;
          // rowIndex 从 0 开始；CSV 行号 = rowIndex + 1（与表头开关无关）
          if (firstRowIsHeader && rowIndex === 0) return;
          if (row.length <= colIndex) return;
          const cell = (row[colIndex] ?? '').trim();
          if (!cell) return;
          const tags =
            tagsColIndex !== null && row.length > tagsColIndex
              ? parseTagsCellValue(row[tagsColIndex])
              : [];
          const offsetStr =
            offsetColIndex !== null && row.length > offsetColIndex
              ? String(row[offsetColIndex] ?? '').trim()
              : '';
          picked.push({
            levelStr: cell,
            slimRow: buildSlimRow(row),
            csvRow: rowIndex + 1,
            tags,
            offsetStr,
          });
        },
        {
          onProgress: (loaded) => {
            // 节流到每 ~150ms 更新一次 UI，避免大量 DOM 写入拖慢解析
            const now = performance.now();
            if (now - lastProgressUpdate < 150 || !progressEl) return;
            lastProgressUpdate = now;
            const pct =
              totalBytes > 0
                ? Math.min(100, Math.floor((loaded / totalBytes) * 100))
                : 0;
            progressEl.textContent = `正在扫描 ${pct}%（已读取 ${picked.length.toLocaleString()} 条）`;
          },
        },
      );

      if (!picked.length) {
        window.alert('所选列中未解析到任何非空关卡串。');
        return;
      }
      // 行数过大时让用户二次确认，避免无意中触发数十秒级的 DOM 构建
      if (picked.length > BoardPreviewApp.LARGE_IMPORT_THRESHOLD) {
        const ok = window.confirm(
          `本次将导入 ${picked.length.toLocaleString()} 条预览框，浏览器可能短时间卡顿（DOM 量大）。\n\n继续吗？`,
        );
        if (!ok) return;
      }
      this._csvHeader = firstRowIsHeader ? [...firstRow] : null;
      this._csvColumnCount = columnCount;
      this._csvTagsColumnIndex = tagsColIndex;
      this._csvOffsetColumnIndex = offsetColIndex;

      this._resetEntries();
      await this._batchAddLazyEntries(picked, (built, total) => {
        if (!progressEl) return;
        const now = performance.now();
        if (now - lastProgressUpdate < 100) return;
        lastProgressUpdate = now;
        const pct = total > 0 ? Math.floor((built / total) * 100) : 0;
        progressEl.textContent = `正在构建预览框 ${pct}%（${built.toLocaleString()} / ${total.toLocaleString()}）`;
      });
      this._refreshSequenceBadges();
      this._renderStatus();
      this._renderPredefinedSummary();
      this._csvImported = true;
      this._toast(
        `已导入 ${picked.length.toLocaleString()} 条。可在上方修改列选择后再点「确认导入」重新导入。`,
        { kind: 'success', ttl: 4500 },
      );
      // 大文件场景下提醒用户：导出 CSV 时仅保留所选列，其他列已被丢弃以释放内存
      if (totalBytes > BoardPreviewApp.LARGE_FILE_BYTES) {
        this._toast(
          '大文件导入：为控制内存，仅保留所选「关卡 / 标签 / Offset」列；导出 CSV 时其他列将为空。',
          { kind: 'warn', ttl: 7000 },
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.alert(`CSV 导入失败：${msg}`);
    } finally {
      this._csvImporting = false;
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = prevConfirmText || '确认导入';
      }
      if (cancelBtn) cancelBtn.disabled = false;
      if (progressEl) {
        progressEl.hidden = true;
        progressEl.textContent = '';
      }
    }
  }

  /**
   * 用户修改列选择下拉（或表头开关）时的统一警告：告知"重新导入会丢失 Cell 编辑"
   * 但不阻止用户继续操作。
   *
   * 同一帧内多次触发只发一次，避免某些 UA 的复合事件刷屏。
   */
  _warnReimport() {
    if (this._reimportWarnPending) return;
    this._reimportWarnPending = true;
    window.requestAnimationFrame(() => {
      this._reimportWarnPending = false;
    });
    this._toast(
      '修改列选择后请重新点「确认导入」生效；重新导入会丢失当前 Cell 上的标签与操作编辑。',
      { kind: 'warn', ttl: 5000 },
    );
  }

  _cancelCsvImport() {
    this._pendingCsv = null;
    this._csvImported = false;
    const panel = this.querySelector('.bp-csv-confirm');
    if (panel) {
      panel.hidden = true;
    }
    /** @param {string} selector */
    const clearSelect = (selector) => {
      const target = /** @type {HTMLSelectElement | null} */ (
        this.querySelector(selector)
      );
      if (target) {
        target.innerHTML = '';
        target.disabled = true;
      }
    };
    clearSelect('.bp-csv-column-select');
    clearSelect('.bp-csv-tags-select');
    clearSelect('.bp-csv-offset-select');
    const nameEl = this.querySelector('.bp-csv-confirm__name');
    if (nameEl) {
      nameEl.textContent = '';
    }
  }

}

BoardPreviewApp.Z_OFFSET_KEY = 'bp:z-offset:v2';
BoardPreviewApp.OFFSET_ENABLED_KEY = 'bp:offset-enabled:v1';
BoardPreviewApp.OFFSET_UNIT_PCT_KEY = 'bp:offset-unit-pct:v1';
BoardPreviewApp.CELLS_COLLAPSED_KEY = 'bp:cells-collapsed:v1';
/**
 * 一次导入超过该行数时弹二次确认，避免无意中触发数十秒级的 DOM 构建。
 * 调小过分会打扰用户，调大过分会让"导入 10 万条没提示"显得很危险——
 * 5000 是经验值（一台中端笔记本能在 5 秒内完成构建并不卡）。
 */
BoardPreviewApp.LARGE_IMPORT_THRESHOLD = 5000;
/**
 * 文件大小超过该阈值时触发"列裁剪 trade-off"提示。仅决定是否 toast，
 * 不影响数据正确性；选这个值是因为浏览器从 ~100 MB 起开始出现明显抖动。
 */
BoardPreviewApp.LARGE_FILE_BYTES = 100 * 1024 * 1024;
/**
 * 大批量导入时每帧 append 的 skeleton 条数。500 在一台中端机上每帧 ~5 ms，
 * 能给浏览器留够时间绘制 + 处理用户输入。再大会出现明显卡顿，再小会让总
 * 构建时间变长（多帧调度开销 + observer 注册 batch 太碎）。
 */
BoardPreviewApp.IMPORT_BATCH_SIZE = 500;
/**
 * "进入此缓冲区就水合"——视口上下额外 600 px。值越大滚动越不会出现白屏，
 * 但会让更多 cell 同时水合，内存占用升高。
 */
BoardPreviewApp.HYDRATE_BUFFER_PX = 600;
/**
 * "离开此缓冲区就回收"——视口上下额外 1800 px。比 HYDRATE_BUFFER_PX 大
 * 的部分构成"回收死区"：一旦水合，至少要滚出这一圈才会被换回 skeleton，
 * 防止用户在视口边缘来回滚动时频繁水合 / 回收抖动。
 */
BoardPreviewApp.KEEP_ALIVE_BUFFER_PX = 1800;

customElements.define('board-preview-app', BoardPreviewApp);
