import './board-preview-cell.js';
import { downloadTextFile, readTextFileUtf8 } from '../io/bundle.js';
import {
  parseCsv,
  serializeExportCsv,
  getColumnLabelsFromRows,
  defaultContentColumnIndex,
  getMaxColumnCount,
  DEFAULT_CONTENT_COLUMN,
} from '../io/csv.js';
import { operationsToGlyphString } from '../board/operationGlyphs.js';

export class BoardPreviewApp extends HTMLElement {
  constructor() {
    super();
    /** @type {{ rows: string[][], fileName: string } | null} */
    this._pendingCsv = null;
    /** 已导入 CSV 的表头（含表头时为首行；无表头为 null） */
    /** @type {string[] | null} */
    this._csvHeader = null;
    /** 已导入 CSV 的列数（无表头时用于补齐输出） */
    this._csvColumnCount = 0;
    /** 用户在页头预设的标签（去重保序，逗号 / 中文逗号 / 空格分隔均可） */
    /** @type {string[]} */
    this._predefinedTags = [];
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
    /** 骨架元素 → entry 反查（仅未水合的 entry 在内） */
    /** @type {WeakMap<Element, object>} */
    this._entryByEl = new WeakMap();
    /** @type {IntersectionObserver | null} */
    this._observer = null;
    /**
     * Z 轴视觉偏移（仅渲染效果，不影响 levelStr / operations / 导出）。
     * x、y 单位为「棋子宽度的百分比」，可正可负。
     * 默认开启 + 右上方向偏移（offsetX=+8%、offsetY=-10%）。
     * @type {{ enabled: boolean, x: number, y: number }}
     */
    this._zOffset = this._loadZOffset();
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
          <span class="bp-app__csv-hint">CSV：选择文件后<strong>自动读取表头</strong>，在下方选择关卡串所在列；默认选中 <code>${DEFAULT_CONTENT_COLUMN}</code> 列（不区分大小写）。</span>
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
            <button type="button" class="bp-btn bp-btn--primary" data-action="confirm-csv-import">确认导入</button>
            <button type="button" class="bp-btn" data-action="cancel-csv-import">取消</button>
          </div>
          <div class="bp-csv-row">
            <button type="button" class="bp-btn" data-action="export-csv">导出 CSV</button>
            <button type="button" class="bp-btn" data-action="export-csv-tag">按标签导出 CSV…</button>
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
          ${this._zOffsetGroupHtml('header')}
          <span class="bp-app__zoffset-hint">每升一层 z 按棋子宽度的百分比偏移（仅渲染效果，不影响导出）。</span>
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
            预览框内可直接从下拉框选择；如需临时新增可选「自定义…」。
          </span>
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
          <button type="button" class="bp-btn" data-action="export-csv-tag">按标签导出 CSV…</button>
          <label class="bp-csv-field bp-csv-field--check">
            <input type="checkbox" class="bp-csv-export-index" data-role="index-toggle" />
            Index 列
          </label>
          ${this._jumpGroupHtml('sticky')}
          ${this._zOffsetToggleHtml('sticky')}
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
    `;
    this._grid = /** @type {HTMLDivElement} */ (
      this.querySelector('.bp-app__grid')
    );

    this.addEventListener('click', (e) => this._onDelegatedClick(e));
    this.addEventListener('change', (e) => this._onDelegatedChange(e));
    this.addEventListener('input', (e) => this._onDelegatedInput(e));
    this.addEventListener('keydown', (e) => this._onDelegatedKeydown(e));

    this._initObserver();
    this._initStickyBar();
    this._applyZOffsetToRoot();

    if (this._entries.length === 0) {
      this.addCell();
    }
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
      case 'jump-to':
        this._jumpFromInput(btn);
        break;
      case 'reset-zoffset':
        this._resetZOffset();
        break;
      default:
    }
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
    } else if (role === 'tags-input') {
      this._syncTagsInputs(/** @type {HTMLInputElement} */ (t));
    } else if (role === 'zoffset-toggle') {
      this._onZOffsetToggle(/** @type {HTMLInputElement} */ (t));
    } else if (role === 'zoffset-x' || role === 'zoffset-y') {
      this._onZOffsetNumberChange(/** @type {HTMLInputElement} */ (t));
    }
  }

  /** @param {Event} e */
  _onDelegatedInput(e) {
    const t = /** @type {HTMLElement | null} */ (e.target);
    if (!t) return;
    const role = t.dataset?.role;
    if (role === 'tags-input') {
      this._syncTagsInputs(/** @type {HTMLInputElement} */ (t));
    } else if (role === 'zoffset-x' || role === 'zoffset-y') {
      this._onZOffsetNumberChange(/** @type {HTMLInputElement} */ (t));
    }
  }

  /** @param {HTMLInputElement} source */
  _syncTagsInputs(source) {
    this._predefinedTags = this._parsePredefinedTags(source.value);
    const all = this.querySelectorAll('input[data-role="tags-input"]');
    all.forEach((inp) => {
      const el = /** @type {HTMLInputElement} */ (inp);
      if (el !== source) el.value = source.value;
    });
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
      return;
    }
    this._observer = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          if (!r.isIntersecting) continue;
          const entry = this._entryByEl.get(r.target);
          if (entry) this._hydrateEntry(entry);
        }
      },
      { root: null, rootMargin: '600px 0px', threshold: 0 },
    );
  }

  /**
   * 重置整个预览网格（清空骨架与已水合 cell）
   */
  _resetEntries() {
    if (this._observer) {
      for (const e of this._entries) {
        if (!e.cellEl) {
          this._observer.unobserve(e.el);
        }
      }
    }
    this._entries = [];
    this._entryByEl = new WeakMap();
    this._grid.innerHTML = '';
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
    this._entries.push({
      kind: 'manual',
      el: cell,
      cellEl: cell,
      item: {},
      originalRow: null,
      csvRow: null,
    });
    this._refreshSequenceBadges();
    this._renderStatus();
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

  /** 将骨架替换为真实预览框（一次性，水合后保留） */
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
    skeleton.replaceWith(cell);
    entry.el = cell;
    entry.cellEl = cell;
    if (typeof cell.setPredefinedTags === 'function') {
      cell.setPredefinedTags(this._predefinedTags);
    }
    if (typeof cell.applyBoardZOffset === 'function') {
      cell.applyBoardZOffset(this._zOffset);
    }
    if (entry.originalRow) {
      cell.setOriginalCsvRow(entry.originalRow);
    }
    cell.loadBundleItem(entry.item);
    this._applySequenceBadge(entry);
    this._renderStatus();
  }

  /** @param {(typeof this._entries)[number]} entry */
  _applySequenceBadge(entry) {
    if (!entry.cellEl || typeof entry.cellEl.setSequence !== 'function') return;
    const index = this._entries.indexOf(entry) + 1;
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
      if (e.cellEl && typeof e.cellEl.setSequence === 'function') {
        e.cellEl.setSequence({ index: i + 1, total, csvRow: e.csvRow });
      }
    }
  }

  _renderStatus() {
    this._refreshJumpUi();
    const el = /** @type {HTMLDivElement | null} */ (
      this.querySelector('.bp-app__grid-info')
    );
    if (!el) return;
    const total = this._entries.length;
    const hydrated = this._entries.reduce((n, e) => (e.cellEl ? n + 1 : n), 0);
    if (total === 0 || total === hydrated) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = `共 ${total} 个预览框 · 已渲染 ${hydrated} 个（继续滚动以加载更多）`;
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
      if (!e.cellEl) this._observer.observe(e.el);
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

  exportCsvAll() {
    const entries = this._exportEntries();
    const csv = serializeExportCsv({
      header: this._csvHeader,
      originalColumnCount: this._csvColumnCount,
      entries,
      operatorOf: operationsToGlyphString,
      withIndex: this._csvExportWithIndex(),
    });
    downloadTextFile(csv, 'board-preview-export.csv', 'text/csv;charset=utf-8');
  }

  exportCsvByTag() {
    const tag = window.prompt('要包含的标签（任一匹配即导出该预览框）:', '');
    if (tag === null) return;
    const needle = tag.trim();
    if (!needle) {
      window.alert('未输入标签。');
      return;
    }
    const entries = this._exportEntries().filter((e) =>
      e.item.tags.some((t) => t.includes(needle)),
    );
    if (!entries.length) {
      window.alert('没有带该标签的预览框。');
      return;
    }
    const csv = serializeExportCsv({
      header: this._csvHeader,
      originalColumnCount: this._csvColumnCount,
      entries,
      operatorOf: operationsToGlyphString,
      withIndex: this._csvExportWithIndex(),
    });
    downloadTextFile(csv, `board-preview-${needle}.csv`, 'text/csv;charset=utf-8');
  }

  /** @param {HTMLInputElement} input */
  async _onCsvFileChosen(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const text = await readTextFileUtf8(file);
      const rows = parseCsv(text);
      if (!rows.length) {
        window.alert('CSV 为空或无法解析。');
        return;
      }
      this._pendingCsv = { rows, fileName: file.name };
      const panel = /** @type {HTMLDivElement} */ (
        this.querySelector('.bp-csv-confirm')
      );
      const nameEl = this.querySelector('.bp-csv-confirm__name');
      if (nameEl) {
        nameEl.textContent = `已选择：${file.name}`;
      }
      this._populateCsvColumnSelect();
      if (panel) {
        panel.hidden = false;
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
    const headerEl = /** @type {HTMLInputElement | null} */ (
      this.querySelector('.bp-csv-header')
    );
    if (!sel || !this._pendingCsv) return;

    const { rows } = this._pendingCsv;
    const firstRowIsHeader = Boolean(headerEl?.checked);
    const labels = getColumnLabelsFromRows(rows, firstRowIsHeader);
    sel.innerHTML = '';
    for (let i = 0; i < labels.length; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${labels[i]}（列 ${i}）`;
      sel.appendChild(opt);
    }
    sel.disabled = labels.length === 0;

    const matchAgainst =
      firstRowIsHeader && rows.length
        ? Array.from({ length: labels.length }, (_, i) =>
            (rows[0][i] ?? '').trim(),
          )
        : labels;
    sel.value = String(defaultContentColumnIndex(matchAgainst));
  }

  _confirmCsvImport() {
    if (!this._pendingCsv) {
      window.alert('请先选择 CSV 文件。');
      return;
    }
    const sel = /** @type {HTMLSelectElement | null} */ (
      this.querySelector('.bp-csv-column-select')
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
    const firstRowIsHeader = Boolean(headerEl?.checked);
    try {
      const { rows } = this._pendingCsv;
      const dataStart = firstRowIsHeader ? 1 : 0;
      /** @type {Array<{ levelStr: string, row: string[], csvRow: number }>} */
      const picked = [];
      for (let r = dataStart; r < rows.length; r += 1) {
        const row = rows[r];
        if (!row || row.length <= colIndex) continue;
        const cell = (row[colIndex] ?? '').trim();
        if (!cell) continue;
        picked.push({ levelStr: cell, row, csvRow: r + 1 });
      }
      if (!picked.length) {
        window.alert('所选列中未解析到任何非空关卡串。');
        return;
      }
      this._csvHeader =
        firstRowIsHeader && rows.length > 0 ? [...rows[0]] : null;
      this._csvColumnCount = getMaxColumnCount(rows);

      this._resetEntries();
      for (const { levelStr, row, csvRow } of picked) {
        this._addLazyEntry(
          {
            tags: [],
            sourceLevelStr: levelStr,
            operations: [],
            levelStr,
            meta: { hadZAxisOperation: false },
          },
          row,
          csvRow,
        );
      }
      this._refreshSequenceBadges();
      this._renderStatus();
      this._cancelCsvImport();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.alert(`CSV 导入失败：${msg}`);
    }
  }

  _cancelCsvImport() {
    this._pendingCsv = null;
    const panel = this.querySelector('.bp-csv-confirm');
    if (panel) {
      panel.hidden = true;
    }
    const sel = /** @type {HTMLSelectElement | null} */ (
      this.querySelector('.bp-csv-column-select')
    );
    if (sel) {
      sel.innerHTML = '';
      sel.disabled = true;
    }
    const nameEl = this.querySelector('.bp-csv-confirm__name');
    if (nameEl) {
      nameEl.textContent = '';
    }
  }

}

BoardPreviewApp.Z_OFFSET_KEY = 'bp:z-offset:v2';

customElements.define('board-preview-app', BoardPreviewApp);
