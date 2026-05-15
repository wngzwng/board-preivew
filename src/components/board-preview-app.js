import './board-preview-cell.js';
import {
  serializeExportBundle,
  readBundleFromFile,
  downloadTextFile,
  readTextFileUtf8,
} from '../io/bundle.js';
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

  connectedCallback() {
    this.innerHTML = `
      <header class="bp-app__header">
        <h1 class="bp-app__title">Board 预览 <span class="bp-app__badge">Tile3</span></h1>
        <p class="bp-app__sub">羊了个羊式叠层 · 多预览框 · 资源见 <code>src/assets/</code></p>
        <div class="bp-app__actions">
          <button type="button" class="bp-btn bp-btn--primary" data-action="add-cell">＋ 预览框</button>
          <label class="bp-btn bp-file">
            导入 JSON
            <input type="file" class="bp-app__file" accept="application/json,.json" data-role="json-file" hidden />
          </label>
          <button type="button" class="bp-btn" data-action="export-all">全部导出 JSON</button>
          <button type="button" class="bp-btn" data-action="export-tag">按标签导出 JSON…</button>
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
            导入 JSON
            <input type="file" class="bp-app__file-sticky" accept="application/json,.json" data-role="json-file" hidden />
          </label>
          <button type="button" class="bp-btn" data-action="export-all">全部导出 JSON</button>
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

    this._initObserver();
    this._initStickyBar();

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
      case 'export-all':
        this.exportAll();
        break;
      case 'export-tag':
        this.exportByTag();
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
      default:
    }
  }

  /** @param {Event} e */
  _onDelegatedChange(e) {
    const t = /** @type {HTMLElement | null} */ (e.target);
    if (!t) return;
    const role = t.dataset?.role;
    if (role === 'json-file') {
      this._onImportFile(/** @type {HTMLInputElement} */ (t));
    } else if (role === 'csv-file') {
      this._onCsvFileChosen(/** @type {HTMLInputElement} */ (t));
    } else if (role === 'index-toggle') {
      this._syncIndexToggles(/** @type {HTMLInputElement} */ (t));
    } else if (t.classList.contains('bp-csv-header')) {
      if (this._pendingCsv) this._populateCsvColumnSelect();
    } else if (role === 'tags-input') {
      this._syncTagsInputs(/** @type {HTMLInputElement} */ (t));
    }
  }

  /** @param {Event} e */
  _onDelegatedInput(e) {
    const t = /** @type {HTMLElement | null} */ (e.target);
    if (!t) return;
    if (t.dataset?.role === 'tags-input') {
      this._syncTagsInputs(/** @type {HTMLInputElement} */ (t));
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

  exportAll() {
    const items = this._effectiveEntries().map((e) => e.item);
    const text = serializeExportBundle(items);
    downloadTextFile(text, 'board-preview-export.json');
  }

  exportByTag() {
    const tag = window.prompt('要包含的标签（任一匹配即导出该预览框）:', '');
    if (tag === null) return;
    const needle = tag.trim();
    if (!needle) {
      window.alert('未输入标签。');
      return;
    }
    const items = this._effectiveEntries()
      .map((e) => e.item)
      .filter((item) =>
        Array.isArray(item.tags) && item.tags.some((t) => t.includes(needle)),
      );
    if (!items.length) {
      window.alert('没有带该标签的预览框。');
      return;
    }
    const text = serializeExportBundle(items);
    downloadTextFile(text, `board-preview-${needle}.json`);
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

  /** @param {HTMLInputElement} input */
  async _onImportFile(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const bundle = await readBundleFromFile(file);
      this._csvHeader = null;
      this._csvColumnCount = 0;
      this._resetEntries();
      for (const item of bundle.items) {
        this._addLazyEntry(item, null);
      }
      this._refreshSequenceBadges();
      this._renderStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.alert(`导入失败：${msg}`);
    }
  }
}

customElements.define('board-preview-app', BoardPreviewApp);
