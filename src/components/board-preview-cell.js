import { fromLevelStr, toLevelStr, sortTiles } from '../codec/levelCodec.js';
import {
  applyBoardOperation,
  getBounds,
  isZAxisOperation,
} from '../board/boardOperations.js';
import {
  operationsToGlyphString,
  BOARD_OP_GLYPH_LEGEND,
} from '../board/operationGlyphs.js';
import { tileAssetPaths } from '../assets/tileSources.js';

export class BoardPreviewCell extends HTMLElement {
  constructor() {
    super();
    /** @type {Array<{ x: number, y: number, z: number, suit: string }>} */
    this._tiles = [];
    /** @type {Array<{ type: string, payload?: object }>} */
    this._operations = [];
    this._hadZ = false;
    this._sourceLevelStr = '';
    /** 来源 CSV 行（导入时附带，导出时回写） */
    /** @type {string[] | null} */
    this._originalCsvRow = null;
    /** 由父级广播下来的预设标签（去重保序） */
    /** @type {string[]} */
    this._predefinedTags = [];
    /** 当前选中的标签集合（去重保序） */
    /** @type {string[]} */
    this._tags = [];
    /**
     * 由父级提供的位置信息（用于在卡片顶部显示「这是第几条」）。
     * @type {{ index: number, total: number, csvRow: number | null } | null}
     */
    this._sequence = null;
  }

  /** @param {string[]} tags */
  setPredefinedTags(tags) {
    const next = Array.isArray(tags) ? tags.filter(Boolean) : [];
    this._predefinedTags = Array.from(new Set(next.map(String)));
    this._renderTagsAdder();
  }

  /**
   * 设置该卡片在父级中的位置信息。
   * @param {{ index: number, total: number, csvRow?: number | null } | null} info
   */
  setSequence(info) {
    if (!info) {
      this._sequence = null;
    } else {
      this._sequence = {
        index: info.index,
        total: info.total,
        csvRow: info.csvRow ?? null,
      };
    }
    this._renderSequence();
  }

  /** @param {string[] | null} row */
  setOriginalCsvRow(row) {
    this._originalCsvRow = row ? [...row] : null;
  }

  /** @returns {string[] | null} */
  getOriginalCsvRow() {
    return this._originalCsvRow ? [...this._originalCsvRow] : null;
  }

  connectedCallback() {
    if (!this.dataset.id) {
      this.dataset.id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `id-${Date.now()}`;
    }
    this.innerHTML = `
      <div class="bp-cell__seq" hidden></div>
      <header class="bp-cell__hdr">
        <label class="bp-cell__label">level 串
          <textarea class="bp-cell__level" rows="3" spellcheck="false" placeholder="粘贴 level_str…"></textarea>
        </label>
        <div class="bp-cell__hdr-side">
          <button type="button" class="bp-cell__decode bp-btn bp-btn--primary">解码 / 应用</button>
          <div class="bp-cell__hdr-sub">
            <button type="button" class="bp-btn bp-btn--sm" data-action="copy-level">复制</button>
            <button type="button" class="bp-btn bp-btn--sm" data-action="paste-level">粘贴</button>
            <button type="button" class="bp-btn bp-btn--sm" data-action="reset-level">回到原始关卡</button>
          </div>
        </div>
      </header>
      <div class="bp-cell__tags">
        <div class="bp-cell__tags-head">
          <span class="bp-cell__label-text">标签</span>
          <select class="bp-cell__tags-add" aria-label="添加标签">
            <option value="" hidden>+ 添加</option>
            <option value="__custom__">自定义…</option>
          </select>
        </div>
        <div class="bp-cell__tags-chips" role="list"></div>
      </div>
      <div class="bp-cell__op-log" hidden>
        <div class="bp-cell__op-log-inner">
          <span class="bp-cell__op-lab">操作记录</span>
          <span class="bp-cell__op-seq"></span>
        </div>
        <p class="bp-cell__op-legend">${BOARD_OP_GLYPH_LEGEND}</p>
      </div>
      <div class="bp-cell__tools" role="toolbar" aria-label="棋盘操作">
        <button type="button" class="bp-btn" data-op="rotate_left">左转</button>
        <button type="button" class="bp-btn" data-op="rotate_right">右转</button>
        <button type="button" class="bp-btn" data-op="mirror_x">X 镜像</button>
        <button type="button" class="bp-btn" data-op="mirror_y">Y 镜像</button>
        <button type="button" class="bp-btn" data-op="flip_z">Z 反转</button>
      </div>
      <div class="bp-cell__err" role="alert" hidden></div>
      <div class="bp-cell__board-wrap">
        <div class="bp-cell__board"></div>
      </div>
    `;
    this._seqEl = /** @type {HTMLDivElement} */ (
      this.querySelector('.bp-cell__seq')
    );
    this._levelTextarea = /** @type {HTMLTextAreaElement} */ (
      this.querySelector('.bp-cell__level')
    );
    this._tagsAddSel = /** @type {HTMLSelectElement} */ (
      this.querySelector('.bp-cell__tags-add')
    );
    this._tagsChipsEl = /** @type {HTMLDivElement} */ (
      this.querySelector('.bp-cell__tags-chips')
    );
    this._tagsAddSel.addEventListener('change', () => this._onTagAddSelected());
    this._tagsChipsEl.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest(
        '[data-remove-tag]',
      );
      if (!btn || !this.contains(btn)) return;
      const tag = btn.getAttribute('data-remove-tag');
      if (tag) this._removeTag(tag);
    });
    this._renderTagsAdder();
    this._renderTagsChips();
    this._renderSequence();
    this._decodeBtn = /** @type {HTMLButtonElement} */ (
      this.querySelector('.bp-cell__decode')
    );
    this._errEl = /** @type {HTMLDivElement} */ (this.querySelector('.bp-cell__err'));
    this._boardEl = /** @type {HTMLDivElement} */ (
      this.querySelector('.bp-cell__board')
    );
    this._toolsEl = /** @type {HTMLDivElement} */ (
      this.querySelector('.bp-cell__tools')
    );
    this._opLogEl = /** @type {HTMLDivElement} */ (
      this.querySelector('.bp-cell__op-log')
    );
    this._opSeqEl = /** @type {HTMLSpanElement} */ (
      this.querySelector('.bp-cell__op-seq')
    );

    this._decodeBtn.addEventListener('click', () => this.applyDecode(true));
    const hdrSide = this.querySelector('.bp-cell__hdr-side');
    hdrSide?.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest('[data-action]');
      if (!btn || !this.contains(btn)) return;
      const act = btn.dataset.action;
      if (act === 'copy-level') {
        void this._copyLevelStr();
      } else if (act === 'paste-level') {
        void this._pasteLevelStr();
      } else if (act === 'reset-level') {
        this._resetToOriginalLevel();
      }
    });
    this._toolsEl.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest('[data-op]');
      if (!btn || !this.contains(btn)) return;
      const op = /** @type {'rotate_left'|'rotate_right'|'mirror_x'|'mirror_y'|'flip_z'} */ (
        btn.dataset.op
      );
      if (op) this.applyOperation(op);
    });

    try {
      const demo = toLevelStr([
        { x: 0, y: 0, z: 0, suit: 'c' },
        { x: 0, y: 1, z: 0, suit: 'c' },
      ]);
      const hint = demo.length > 56 ? `${demo.slice(0, 56)}…` : demo;
      this._levelTextarea.placeholder = `粘贴 level_str 后点「解码」；示例两牌: ${hint}`;
    } catch {
      this._levelTextarea.placeholder = '粘贴 level_str…';
    }

    this._updateOpLog();
  }

  /** @returns {object} */
  getExportItem() {
    const levelStr = this._levelTextarea.value.trim();
    return {
      id: this.dataset.id,
      tags: this.readTags(),
      sourceLevelStr: this._sourceLevelStr,
      operations: this._operations.map((o) => ({ ...o })),
      levelStr,
      meta: { hadZAxisOperation: this._hadZ },
    };
  }

  /** @param {object} item */
  loadBundleItem(item) {
    this._sourceLevelStr = item.sourceLevelStr;
    this._operations = (item.operations ?? []).map((o) => ({ ...o }));
    this._hadZ = Boolean(item.meta?.hadZAxisOperation);
    this._levelTextarea.value = item.levelStr;
    const incomingTags = Array.isArray(item.tags) ? item.tags : [];
    this._tags = Array.from(
      new Set(incomingTags.map((t) => String(t).trim()).filter(Boolean)),
    );
    this._renderTagsChips();
    this.applyDecode(false);
  }

  readTags() {
    return [...this._tags];
  }

  _renderSequence() {
    if (!this._seqEl) return;
    if (!this._sequence) {
      this._seqEl.hidden = true;
      this._seqEl.textContent = '';
      return;
    }
    const { index, total, csvRow } = this._sequence;
    const parts = [];
    if (Number.isFinite(index)) {
      parts.push(
        Number.isFinite(total) ? `第 ${index} / ${total} 条` : `第 ${index} 条`,
      );
    }
    if (csvRow != null) {
      parts.push(`CSV 行 ${csvRow}`);
    }
    if (!parts.length) {
      this._seqEl.hidden = true;
      this._seqEl.textContent = '';
      return;
    }
    this._seqEl.hidden = false;
    this._seqEl.textContent = parts.join(' · ');
  }

  _renderTagsAdder() {
    if (!this._tagsAddSel) return;
    const sel = this._tagsAddSel;
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.hidden = true;
    ph.textContent = '+ 添加';
    sel.appendChild(ph);
    const selectedSet = new Set(this._tags);
    const available = this._predefinedTags.filter((t) => !selectedSet.has(t));
    if (available.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '预设';
      for (const t of available) {
        const opt = document.createElement('option');
        opt.value = `tag:${t}`;
        opt.textContent = t;
        grp.appendChild(opt);
      }
      sel.appendChild(grp);
    }
    const custom = document.createElement('option');
    custom.value = '__custom__';
    custom.textContent = '自定义…';
    sel.appendChild(custom);
    sel.value = '';
  }

  _renderTagsChips() {
    if (!this._tagsChipsEl) return;
    const wrap = this._tagsChipsEl;
    wrap.innerHTML = '';
    if (this._tags.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'bp-cell__tags-empty';
      empty.textContent = '尚未选择标签';
      wrap.appendChild(empty);
    } else {
      for (const tag of this._tags) {
        const chip = document.createElement('span');
        chip.className = 'bp-chip';
        chip.setAttribute('role', 'listitem');
        const label = document.createElement('span');
        label.className = 'bp-chip__label';
        label.textContent = tag;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bp-chip__remove';
        btn.setAttribute('data-remove-tag', tag);
        btn.setAttribute('aria-label', `移除标签 ${tag}`);
        btn.textContent = '×';
        chip.appendChild(label);
        chip.appendChild(btn);
        wrap.appendChild(chip);
      }
    }
    this._renderTagsAdder();
  }

  _onTagAddSelected() {
    const sel = this._tagsAddSel;
    const value = sel.value;
    if (!value) return;
    if (value === '__custom__') {
      const raw = window.prompt('输入自定义标签（多个用逗号分隔）');
      sel.value = '';
      if (!raw) return;
      const parts = raw
        .split(/[，,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      let changed = false;
      for (const t of parts) {
        if (this._addTag(t, false)) changed = true;
      }
      if (changed) this._afterTagsChanged();
      return;
    }
    if (value.startsWith('tag:')) {
      const tag = value.slice(4);
      sel.value = '';
      if (this._addTag(tag, true)) {
        this._afterTagsChanged();
      }
    }
  }

  /**
   * @param {string} tag
   * @param {boolean} _silent
   */
  _addTag(tag, _silent) {
    const t = String(tag).trim();
    if (!t || this._tags.includes(t)) return false;
    this._tags.push(t);
    return true;
  }

  /** @param {string} tag */
  _removeTag(tag) {
    const before = this._tags.length;
    this._tags = this._tags.filter((t) => t !== tag);
    if (this._tags.length !== before) this._afterTagsChanged();
  }

  _afterTagsChanged() {
    this._renderTagsChips();
    this.dispatchEvent(
      new CustomEvent('bp-cell-change', { bubbles: true, composed: true }),
    );
  }

  _updateOpLog() {
    if (!this._opLogEl || !this._opSeqEl) return;
    if (this._operations.length === 0) {
      this._opLogEl.hidden = true;
      this._opSeqEl.textContent = '';
      return;
    }
    this._opLogEl.hidden = false;
    this._opSeqEl.textContent = operationsToGlyphString(this._operations);
  }

  async _copyLevelStr() {
    this._setError('');
    const text = this._levelTextarea.value;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._setError(`复制失败：${msg}（请检查浏览器权限）`);
    }
  }

  async _pasteLevelStr() {
    this._setError('');
    try {
      const text = await navigator.clipboard.readText();
      this._levelTextarea.value = text;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._setError(`粘贴失败：${msg}（请检查浏览器权限）`);
    }
  }

  _resetToOriginalLevel() {
    this._setError('');
    if (!this._sourceLevelStr) {
      this._setError('请先点击「解码 / 应用」以记录原始关卡，再使用本功能。');
      return;
    }
    this._levelTextarea.value = this._sourceLevelStr;
    this._operations = [];
    this._hadZ = false;
    this._updateOpLog();
    this.applyDecode(false);
  }

  /**
   * @param {boolean} resetSession 为 true 时清空操作记录并将当前串记为新的「源」
   */
  applyDecode(resetSession) {
    this._setError('');
    const raw = this._levelTextarea.value.trim();
    try {
      this._tiles = fromLevelStr(raw);
      if (resetSession) {
        this._operations = [];
        this._hadZ = false;
        this._sourceLevelStr = raw;
      }
      this._updateOpLog();
      this._renderBoard();
      this.dispatchEvent(
        new CustomEvent('bp-cell-change', { bubbles: true, composed: true }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._setError(msg);
    }
  }

  /**
   * @param {'rotate_left'|'rotate_right'|'mirror_x'|'mirror_y'|'flip_z'} op
   */
  applyOperation(op) {
    this._setError('');
    if (!this._tiles.length) {
      this._setError('请先解码有效关卡后再操作。');
      return;
    }
    try {
      this._tiles = applyBoardOperation(this._tiles, op);
      this._operations.push({ type: op, payload: {} });
      if (isZAxisOperation(op)) {
        this._hadZ = true;
      }
      this._levelTextarea.value = toLevelStr(this._tiles);
      this._updateOpLog();
      this._renderBoard();
      this.dispatchEvent(
        new CustomEvent('bp-cell-change', { bubbles: true, composed: true }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._setError(msg);
    }
  }

  /** @param {string} message */
  _setError(message) {
    if (!message) {
      this._errEl.textContent = '';
      this._errEl.hidden = true;
      return;
    }
    this._errEl.textContent = message;
    this._errEl.hidden = false;
  }

  _renderBoard() {
    const board = this._boardEl;
    board.innerHTML = '';
    if (!this._tiles.length) {
      board.style.aspectRatio = 'auto';
      board.style.gridTemplateRows = '';
      board.style.gridTemplateColumns = '';
      const p = document.createElement('p');
      p.className = 'bp-cell__empty';
      p.textContent = '无牌（解码后显示）';
      board.appendChild(p);
      return;
    }

    const { xmin, xmax, ymin, ymax } = getBounds(this._tiles);
    const rowCells = Math.max(1, xmax - xmin + 2);
    const colCells = Math.max(1, ymax - ymin + 2);
    board.style.gridTemplateRows = `repeat(${rowCells}, 1fr)`;
    board.style.gridTemplateColumns = `repeat(${colCells}, 1fr)`;
    board.style.aspectRatio = `${colCells} / ${rowCells}`;

    const order = sortTiles(this._tiles);
    let i = 0;
    for (const t of order) {
      const div = document.createElement('div');
      div.className = 'bp-tile';
      div.style.gridRow = `${t.x - xmin + 1} / span 2`;
      div.style.gridColumn = `${t.y - ymin + 1} / span 2`;
      div.style.zIndex = String(100 + t.z * 10 + (i += 1));
      const { base } = tileAssetPaths(t.suit);
      const imgBase = document.createElement('img');
      imgBase.className = 'bp-tile__base';
      imgBase.src = base;
      imgBase.alt = '';
      imgBase.draggable = false;
      imgBase.loading = 'lazy';
      imgBase.addEventListener('error', () => {
        imgBase.remove();
      });

      const face = document.createElement('span');
      face.className = 'bp-tile__suit';
      face.textContent = t.suit || '·';
      face.title = `z${t.z} 行${t.x} 列${t.y} ${t.suit || ''}`.trim();

      div.appendChild(imgBase);
      div.appendChild(face);
      board.appendChild(div);
    }
  }
}

customElements.define('board-preview-cell', BoardPreviewCell);
