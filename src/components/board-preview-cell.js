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
import { tagHue } from '../utils/tagColor.js';

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
    /**
     * 由父级广播下来的 Z 轴视觉偏移（仅影响渲染）。
     * @type {{ enabled: boolean, x: number, y: number }}
     */
    this._zOffset = { enabled: false, x: 0, y: 0 };
  }

  /**
   * 接收父级的 Z 偏移设置：更新本地状态并刷新棋盘外边距，不重建 tile DOM。
   * @param {{ enabled: boolean, x: number, y: number }} opts
   */
  applyBoardZOffset(opts) {
    if (!opts || typeof opts !== 'object') return;
    this._zOffset = {
      enabled: !!opts.enabled,
      x: Number.isFinite(opts.x) ? opts.x : 0,
      y: Number.isFinite(opts.y) ? opts.y : 0,
    };
    this._updateBoardZOffsetStyle();
  }

  /**
   * 根据当前 _zOffset 与当前棋盘 bounds 计算棋盘容器的 padding，
   * 为上层 tile 偏出原始范围预留视觉空间。
   * padding 单位为 % 时是相对父元素（board-wrap）宽度的，而 board 自身 width=100%，
   * 所以下面的公式直接用 board 宽度的百分比来推导。
   */
  _updateBoardZOffsetStyle() {
    const board = this._boardEl;
    if (!board) return;
    const { enabled, x, y } = this._zOffset;
    if (!enabled || !this._tiles.length) {
      board.style.removeProperty('--bp-board-pad-top');
      board.style.removeProperty('--bp-board-pad-right');
      board.style.removeProperty('--bp-board-pad-bottom');
      board.style.removeProperty('--bp-board-pad-left');
      return;
    }
    const { xmin, xmax, ymin, ymax, zmin, zmax } = getBounds(this._tiles);
    const layers = Math.max(0, (zmax ?? 0) - (zmin ?? 0));
    const colCells = Math.max(1, ymax - ymin + 2);
    const rowCells = Math.max(1, xmax - xmin + 2);
    if (layers === 0) {
      board.style.removeProperty('--bp-board-pad-top');
      board.style.removeProperty('--bp-board-pad-right');
      board.style.removeProperty('--bp-board-pad-bottom');
      board.style.removeProperty('--bp-board-pad-left');
      return;
    }
    // tileWidth = boardWidth * 2/colCells；tileHeight = boardHeight * 2/rowCells；
    // 两者相等（每格 1fr 1fr 正方形）。
    // 最高层水平偏移 = layers * tileWidth * |x|%
    //               = boardWidth * layers * |x| * 2 / colCells / 100
    // padding-X % 相对 wrap（≈ boardWidth），故 padding% = layers * |x| * 2 / colCells
    // 垂直方向 padding-top/bottom 的 % 也是相对父宽度，需用对应的 row 维度换算：
    // 最高层垂直偏移 = layers * tileHeight * |y|% = boardHeight * 2 * layers * |y| / rowCells / 100
    // 而 padding% 相对 boardWidth = boardHeight * colCells / rowCells，
    // 所以 padding-top% = (上式 / boardWidth) * 100 = layers * |y| * 2 / colCells
    // 推导：tileHeight = boardWidth * 2 / colCells（因为是正方形）
    const factor = 2 / colCells;
    const padTop = layers * Math.max(0, -y) * factor;
    const padBottom = layers * Math.max(0, y) * factor;
    const padLeft = layers * Math.max(0, -x) * factor;
    const padRight = layers * Math.max(0, x) * factor;
    board.style.setProperty('--bp-board-pad-top', `${padTop.toFixed(3)}%`);
    board.style.setProperty('--bp-board-pad-right', `${padRight.toFixed(3)}%`);
    board.style.setProperty(
      '--bp-board-pad-bottom',
      `${padBottom.toFixed(3)}%`,
    );
    board.style.setProperty('--bp-board-pad-left', `${padLeft.toFixed(3)}%`);
    // 备用：避免被遗留 row 维度需要时用到（目前用 colCells 已覆盖正方形格子的情况）
    void rowCells;
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
            <button type="button" class="bp-btn bp-btn--sm" data-action="reset-level" aria-label="重置为原始关卡">重置</button>
            <button type="button" class="bp-btn bp-btn--sm" data-action="download-png" aria-label="下载 PNG 图片">下载 PNG</button>
          </div>
        </div>
      </header>
      <div class="bp-cell__tags">
        <div class="bp-cell__tags-head">
          <span class="bp-cell__label-text">标签</span>
          <select class="bp-cell__tags-add" aria-label="添加标签">
            <option value="" hidden>+ 添加</option>
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
      <div class="bp-cell__bounds" aria-label="棋盘范围" hidden>
        <span class="bp-cell__bounds-item">
          <span class="bp-cell__bounds-label">x 最大</span>
          <span class="bp-cell__bounds-value" data-bounds="x">0</span>
        </span>
        <span class="bp-cell__bounds-item">
          <span class="bp-cell__bounds-label">y 最大</span>
          <span class="bp-cell__bounds-value" data-bounds="y">0</span>
        </span>
        <span class="bp-cell__bounds-item">
          <span class="bp-cell__bounds-label">z 最大</span>
          <span class="bp-cell__bounds-value" data-bounds="z">0</span>
        </span>
      </div>
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
    this._boundsEl = /** @type {HTMLDivElement} */ (
      this.querySelector('.bp-cell__bounds')
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
    this.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement | null} */ (
        /** @type {HTMLElement} */ (e.target).closest('[data-action]')
      );
      if (!btn || !this.contains(btn)) return;
      const act = btn.dataset.action;
      if (act === 'copy-level') {
        void this._copyLevelStr();
      } else if (act === 'paste-level') {
        void this._pasteLevelStr();
      } else if (act === 'reset-level') {
        this._resetToOriginalLevel();
      } else if (act === 'download-png') {
        void this._downloadBoardPng();
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
        chip.style.setProperty('--chip-h', String(tagHue(tag)));
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

  /**
   * 向上派发 toast 事件（由 BoardPreviewApp 监听并展示）。
   * @param {string} message
   * @param {'info' | 'success' | 'warn' | 'error'} [kind]
   */
  _emitToast(message, kind = 'info') {
    this.dispatchEvent(
      new CustomEvent('bp:toast', {
        detail: { message, kind },
        bubbles: true,
        composed: true,
      }),
    );
  }

  async _copyLevelStr() {
    this._setError('');
    const text = this._levelTextarea.value;
    if (!text) {
      this._emitToast('当前没有可复制的 level 串。', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this._emitToast('已复制 level 串到剪贴板', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._setError(`复制失败：${msg}（请检查浏览器权限）`);
      this._emitToast('复制失败，请检查浏览器权限', 'error');
    }
  }

  async _pasteLevelStr() {
    this._setError('');
    try {
      const text = await navigator.clipboard.readText();
      this._levelTextarea.value = text;
      // 有原始关卡时，提醒用户：再点「解码 / 应用」会把原始关卡覆盖为这次粘贴的内容，
      // 此后「重置」将不再能回到旧关卡。仅在已记录原始关卡时发出，避免无谓打扰。
      if (this._sourceLevelStr) {
        this._emitToast(
          '已粘贴 — 注意：点击「解码 / 应用」会覆盖当前的原始关卡',
          'warn',
        );
      } else {
        this._emitToast('已从剪贴板粘贴', 'success');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._setError(`粘贴失败：${msg}（请检查浏览器权限）`);
      this._emitToast('粘贴失败，请检查浏览器权限', 'error');
    }
  }

  _resetToOriginalLevel() {
    this._setError('');
    if (!this._sourceLevelStr) {
      this._setError('请先点击「解码 / 应用」以记录原始关卡，再使用本功能。');
      this._emitToast('尚无原始关卡，请先解码', 'warn');
      return;
    }
    this._levelTextarea.value = this._sourceLevelStr;
    this._operations = [];
    this._hadZ = false;
    this._updateOpLog();
    this.applyDecode(false);
    this._emitToast('已重置为原始关卡', 'success');
  }

  /**
   * 把当前棋盘（含 Z 偏移）绘到一个独立 canvas 并触发下载。
   * 失败时通过 toast 与 _setError 双通道提示。
   */
  async _downloadBoardPng() {
    this._setError('');
    if (!this._tiles.length) {
      this._emitToast('请先解码出有效棋盘后再下载。', 'warn');
      return;
    }
    try {
      const blob = await this._renderBoardToPng();
      if (!blob) throw new Error('canvas 转换为图片失败');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this._buildPngFileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this._emitToast('已开始下载棋盘 PNG', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._setError(`下载 PNG 失败：${msg}`);
      this._emitToast(`下载 PNG 失败：${msg}`, 'error');
    }
  }

  _buildPngFileName() {
    const seq = this._sequence?.index;
    const tail = Number.isFinite(seq) ? `-${seq}` : '';
    return `board-preview${tail}.png`;
  }

  /**
   * 基于 _tiles + _zOffset 在离屏 canvas 上重绘棋盘并返回 PNG Blob。
   * 不依赖 DOM，确保导出尺寸与 padding 与屏幕展示一致（按 colCells 计算占比）。
   * @returns {Promise<Blob | null>}
   */
  async _renderBoardToPng() {
    const TILE_PX = 96;
    const PAD_PX = 18;
    const GAP_PX = 2;
    const { xmin, xmax, ymin, ymax, zmin, zmax } = getBounds(this._tiles);
    const rowCells = Math.max(1, xmax - xmin + 2);
    const colCells = Math.max(1, ymax - ymin + 2);
    const layers = Math.max(0, (zmax ?? 0) - (zmin ?? 0));
    const { enabled, x: zoX, y: zoY } = this._zOffset || {
      enabled: false,
      x: 0,
      y: 0,
    };
    // padding 与屏幕版逻辑一致：层数 × |偏移%| × tile/格占比；离屏 canvas 直接用 px。
    const padScale = enabled && layers > 0 ? (TILE_PX * layers) / 100 : 0;
    const padTop = PAD_PX + Math.max(0, -zoY) * padScale;
    const padBottom = PAD_PX + Math.max(0, zoY) * padScale;
    const padLeft = PAD_PX + Math.max(0, -zoX) * padScale;
    const padRight = PAD_PX + Math.max(0, zoX) * padScale;
    const innerW = colCells * TILE_PX + (colCells - 1) * GAP_PX;
    const innerH = rowCells * TILE_PX + (rowCells - 1) * GAP_PX;
    const width = Math.ceil(padLeft + innerW + padRight);
    const height = Math.ceil(padTop + innerH + padBottom);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持 canvas 2D');

    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#143d2e');
    bgGrad.addColorStop(1, '#0d2818');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    const order = sortTiles(this._tiles);
    const baseCache = new Map();
    /** @param {string} src */
    const loadImg = (src) => {
      if (!src) return Promise.resolve(null);
      if (baseCache.has(src)) return baseCache.get(src);
      const p = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      });
      baseCache.set(src, p);
      return p;
    };

    for (const t of order) {
      const baseLeft =
        padLeft + (t.y - ymin) * (TILE_PX / 2 + GAP_PX / 2);
      // tile 实际宽度等于 2 grid cell + 1 gap：
      const tileWidth = TILE_PX * 2 + GAP_PX;
      const tileHeight = TILE_PX * 2 + GAP_PX;
      const xCell = (t.y - ymin) * (TILE_PX + GAP_PX);
      const yCell = (t.x - xmin) * (TILE_PX + GAP_PX);
      let drawX = padLeft + xCell;
      let drawY = padTop + yCell;
      if (enabled && layers > 0) {
        const zLevel = t.z - (zmin ?? 0);
        drawX += (zLevel * zoX * tileWidth) / 100;
        drawY += (zLevel * zoY * tileHeight) / 100;
      }
      void baseLeft;
      const { base } = tileAssetPaths(t.suit);
      const img = await loadImg(base);
      if (img) {
        ctx.drawImage(img, drawX, drawY, tileWidth, tileHeight);
      } else {
        ctx.fillStyle = '#153528';
        ctx.fillRect(drawX, drawY, tileWidth, tileHeight);
      }
      const label = t.suit || '·';
      ctx.font =
        '600 28px ui-sans-serif, system-ui, -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.fillText(label, drawX + tileWidth / 2, drawY + tileHeight / 2);
    }

    return await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
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

  /**
   * 更新「x/y/z 最大值」状态行；传入 null 表示空棋盘（隐藏整行）。
   * @param {{ xmax: number, ymax: number, zmax: number } | null} info
   */
  _renderBounds(info) {
    const el = this._boundsEl;
    if (!el) return;
    if (!info) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const setVal = (key, value) => {
      const node = el.querySelector(`[data-bounds="${key}"]`);
      if (node) node.textContent = String(value);
    };
    setVal('x', info.xmax);
    setVal('y', info.ymax);
    setVal('z', info.zmax);
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
      this._renderBounds(null);
      return;
    }

    const { xmin, xmax, ymin, ymax, zmin, zmax } = getBounds(this._tiles);
    // 显示的「最大值」按整盘可达坐标计：tile 锚点 (x, y) 占 2×2 单元格，
    // 故 x 方向最大可达 xmax + 2、y 方向 ymax + 2；z 是层号（从 0 起），层数 = zmax + 1。
    this._renderBounds({
      xmax: xmax + 2,
      ymax: ymax + 2,
      zmax: zmax + 1,
    });
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
      div.style.setProperty('--bp-tile-z', String(t.z - (zmin ?? 0)));
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
    this._updateBoardZOffsetStyle();
  }
}

customElements.define('board-preview-cell', BoardPreviewCell);
