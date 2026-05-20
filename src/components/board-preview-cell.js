import { fromLevelStr, toLevelStr, sortTiles } from '../codec/levelCodec.js';
import {
  applyBoardOperation,
  getBounds,
  getFootprintCellBounds,
  isZAxisOperation,
} from '../board/boardOperations.js';
import {
  applyBoardOperationToOffsets,
} from '../board/offsetOperations.js';
import {
  operationsToGlyphString,
  BOARD_OP_GLYPH_LEGEND,
} from '../board/operationGlyphs.js';
import { tileAssetPaths } from '../assets/tileSources.js';
import { tagHue } from '../utils/tagColor.js';
import {
  parseOffsetStr,
  serializeOffsetRecords,
  OFFSET_DIRECTION_VECTORS,
} from '../codec/offsetCodec.js';
import { applyOffsetsToTiles, towerKey } from '../board/offsetApply.js';

export class BoardPreviewCell extends HTMLElement {
  constructor() {
    super();
    /** @type {Array<{ row: number, col: number, z: number, suit: string }>} */
    this._tiles = [];
    /** @type {Array<{ type: string, payload?: object }>} */
    this._operations = [];
    this._hadZ = false;
    this._sourceLevelStr = '';
    /**
     * 与 level 串平行的 offset 串。详见 docs/proposals/board-offset.md。
     * 空串视为"无 offset"，渲染层退化为不叠加（仍保留 Z 偏移）。
     */
    this._sourceOffsetStr = '';
    /**
     * 解码后的柱子级 offset 映射：`Map<"row,col", OffsetRecord>`，
     * 由 `applyOffsetsToTiles` 严格校验（命中 Tile / 唯一）后产生；
     * 解析失败时清空，仅显示错误，不影响 level 渲染（详见 _applyOffset）。
     * @type {Map<string, import('../codec/offsetCodec.js').OffsetRecord>}
     */
    this._offsetByAnchor = new Map();
    /**
     * 解码后的 OffsetRecord 列表——作为运行时 source of truth：
     * - `_offsetByAnchor` 是按锚点索引的查询视图（每柱一条，取 z 最小那条）；
     * - `_offsetRecords` 保留**全部记录**用于几何变换与序列化，避免重复解析 textarea。
     *
     * `applyOperation` 时需要对它整体施加 `applyBoardOperationToOffsets` 并把
     * 结果回写到 textarea，所以必须以列表形式持久化。
     * @type {import('../codec/offsetCodec.js').OffsetRecord[]}
     */
    this._offsetRecords = [];
    /**
     * 由父级广播下来的「Offset 视觉效果」全局开关。
     * - true：渲染时把柱子级 offset 反映到 CSS / PNG（与 Z 偏移可叠加）；
     * - false：忽略 offset，棋盘按"无 offset"渲染（解析结果与串本身保留）。
     *
     * 屏幕渲染主要靠 host class `.bp-app--offset-on` 与 `--bp-offset-on` 变量驱动，
     * 此字段仅用于 PNG 导出路径同步状态（canvas 渲染不读 CSS）。
     * @type {boolean}
     */
    this._offsetEnabled = true;
    /**
     * 由父级广播下来的「Offset 单层增量缩放系数」（整数 1–5，默认 1）。
     *
     * 渲染端：单层增量 = `(magnitude + 1) × offsetUnitPct%`。
     * - CSS：透过 host 上的 `--bp-offset-unit-pct` 变量在 transform calc 中相乘，
     *   cell 端注入的 `--bp-tile-offset-x/y` 只是"无量纲方向 × 档位"，
     *   故缩放变化时**无需重建 DOM**。
     * - PNG / padding 计算：canvas 与 CSS 隔绝，需要从 JS 直接读取本字段。
     * @type {number}
     */
    this._offsetUnitPct = 1;
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
   * 接收父级广播的「Offset 视觉效果」全局开关。
   *
   * 屏幕渲染由 CSS 驱动（host class + 数值变量），无需重排 DOM；
   * 仅在状态变化时刷新 board padding（offset 可能会让 tile 越出原 bounds），
   * 以及让后续 PNG 导出读到最新状态。
   *
   * @param {boolean} enabled
   */
  applyOffsetEnabled(enabled) {
    const next = !!enabled;
    if (next === this._offsetEnabled) return;
    this._offsetEnabled = next;
    this._updateBoardZOffsetStyle();
  }

  /**
   * 接收父级广播的「Offset 单层增量缩放系数」。
   *
   * 屏幕 transform 通过 host 上的 `--bp-offset-unit-pct` 变量自动联动，
   * 这里只需刷新 board padding（系数变大时所需视觉空间也变大）。
   *
   * @param {number} pct 期望取整后的 1–5；非法值容错为 1。
   */
  applyOffsetUnitPct(pct) {
    const n = Math.round(Number(pct));
    const next = Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 1;
    if (next === this._offsetUnitPct) return;
    this._offsetUnitPct = next;
    this._updateBoardZOffsetStyle();
  }

  /**
   * 计算棋盘容器的 padding，为受 Z 偏移 / 柱子级 offset 影响的 tile **偏出原始 bounds**
   * 预留视觉空间，避免渲染溢出 cell 边框。
   *
   * 推导（统一单位为 "% of board width"）：
   * - 每个 tile 的偏移分量都是 `K × tileWidth`（K 为无量纲系数）；
   * - `tileWidth / boardWidth = 2 / colCells`（每格 1fr 1fr 的正方形 grid）；
   * - 故 tile 偏移占 board 宽度的百分比 = `K × factor × 100%`，其中 `factor = 2 / colCells`。
   *
   * 分别考虑两个来源（与 _renderBoard / _renderBoardToPng 同公式）：
   *   Z 偏移分量： K = zLevel × (zoX|zoY) / 100        （zoX/zoY 是百分比）
   *   Offset 分量： K = layerDelta × (mag+1) × unitPct/100 × dRow|dCol
   *                 （unitPct 是渲染端可调系数，默认 1，最大 5）
   *
   * 实现策略：遍历所有 tile 算出"综合偏移"，按四方向取最大值做 padding——
   * 比按 `layers × |x|` 等粗略上界更紧，避免过大留白。
   */
  _updateBoardZOffsetStyle() {
    const board = this._boardEl;
    if (!board) return;
    const tiles = this._tiles;
    if (!tiles.length) {
      board.style.removeProperty('--bp-board-pad-top');
      board.style.removeProperty('--bp-board-pad-right');
      board.style.removeProperty('--bp-board-pad-bottom');
      board.style.removeProperty('--bp-board-pad-left');
      return;
    }
    const { rowMin, rowMax, colMin, colMax, zMin } = getBounds(tiles);
    const colCells = Math.max(1, colMax - colMin + 2);
    const factor = 2 / colCells;
    const { enabled: zEnabled, x: zoX, y: zoY } = this._zOffset;
    const offsetEnabled = this._offsetEnabled;
    const zBase = zMin ?? 0;
    let maxLeft = 0;
    let maxRight = 0;
    let maxTop = 0;
    let maxBottom = 0;
    for (const t of tiles) {
      let offX = 0;
      let offY = 0;
      if (zEnabled) {
        const zLevel = t.z - zBase;
        offX += zLevel * zoX * factor;
        offY += zLevel * zoY * factor;
      }
      if (offsetEnabled) {
        const r = this._offsetByAnchor.get(towerKey(t.row, t.col));
        if (r) {
          const [dRow, dCol] = OFFSET_DIRECTION_VECTORS[r.direction];
          const layerDelta = t.z - r.z;
          // 单层增量百分比 = (mag+1) × unitPct%（与屏幕/PNG 同源）
          const stepPct = (r.magnitude + 1) * this._offsetUnitPct;
          offX += dCol * layerDelta * stepPct * factor;
          offY += dRow * layerDelta * stepPct * factor;
        }
      }
      if (offX < 0) maxLeft = Math.max(maxLeft, -offX);
      if (offX > 0) maxRight = Math.max(maxRight, offX);
      if (offY < 0) maxTop = Math.max(maxTop, -offY);
      if (offY > 0) maxBottom = Math.max(maxBottom, offY);
    }
    if (maxLeft === 0 && maxRight === 0 && maxTop === 0 && maxBottom === 0) {
      board.style.removeProperty('--bp-board-pad-top');
      board.style.removeProperty('--bp-board-pad-right');
      board.style.removeProperty('--bp-board-pad-bottom');
      board.style.removeProperty('--bp-board-pad-left');
      return;
    }
    // === padding 公式（已拆分 outer/inner 结构后的版本）===
    //
    // 结构：outer (`bp-cell__board`) 承担 padding；inner (`bp-cell__board-grid`)
    // 承担 `width: 100%` 与 `aspect-ratio: colCells/rowCells`。所以 inner 永远
    // 是 `colCells:rowCells` 比例的纯净容器，`1fr × 1fr` cell 永远正方形。
    //
    // 设 outer_w = parent 宽度（width: 100%），padding 百分比相对 outer 父宽度。
    //
    // **X 方向**：padding-L/R 直接缩 inner_w，inner_w 又决定 tile_w，
    // tile 自身 transform-x 又是 tile_w 的百分比——非线性反馈，必须解稳定点：
    //   padR ≥ K_R × (1 - padL - padR)  →  P_x = K_x / (1 + K_x)
    //
    // **Y 方向**：inner_h = inner_w × rowCells/colCells，**与 padding-top/bottom 无关**。
    // tile_h = inner_h / rowCells × 2 = inner_w × 2/colCells，所以 tile_h 完全
    // 由 X 方向 padding 决定。padding-top/bottom 不再反馈回 tile 大小，是**线性**关系：
    //   padT = K_T × (1 - P_x)   ← 1 - P_x 就是 inner_w / outer_w
    //
    // 把 X、Y 解耦后，Y 不再无谓地"求稳定点"过度留白，最终视觉更紧凑。
    const Kxt = maxLeft + maxRight;
    let padLeftPct = 0;
    let padRightPct = 0;
    let padTopPct = 0;
    let padBottomPct = 0;
    let innerWFactor = 1; // inner_w / outer_w
    if (Kxt > 0) {
      const PxPct = (Kxt * 100) / (100 + Kxt);
      padLeftPct = (maxLeft / Kxt) * PxPct;
      padRightPct = (maxRight / Kxt) * PxPct;
      innerWFactor = 1 - PxPct / 100;
    }
    padTopPct = maxTop * innerWFactor;
    padBottomPct = maxBottom * innerWFactor;
    board.style.setProperty('--bp-board-pad-top', `${padTopPct.toFixed(3)}%`);
    board.style.setProperty(
      '--bp-board-pad-right',
      `${padRightPct.toFixed(3)}%`,
    );
    board.style.setProperty(
      '--bp-board-pad-bottom',
      `${padBottomPct.toFixed(3)}%`,
    );
    board.style.setProperty('--bp-board-pad-left', `${padLeftPct.toFixed(3)}%`);
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
            <button type="button" class="bp-btn bp-btn--sm" data-action="copy-level">复制 level</button>
            <button type="button" class="bp-btn bp-btn--sm" data-action="paste-level">粘贴 level</button>
            <button type="button" class="bp-btn bp-btn--sm" data-action="reset-level" aria-label="重置为原始关卡（level + offset）">重置</button>
            <button type="button" class="bp-btn bp-btn--sm" data-action="download-png" aria-label="下载 PNG 图片">下载 PNG</button>
          </div>
        </div>
      </header>
      <div class="bp-cell__offset">
        <label class="bp-cell__label">offset 串（可选）
          <textarea class="bp-cell__offset-str" rows="1" spellcheck="false" placeholder="粘贴 offset_str（4 字符组：z+row+col+marker，留空即无 offset）"></textarea>
        </label>
        <div class="bp-cell__offset-side">
          <button type="button" class="bp-btn bp-btn--sm" data-action="copy-offset">复制 offset</button>
          <button type="button" class="bp-btn bp-btn--sm" data-action="paste-offset">粘贴 offset</button>
        </div>
      </div>
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
          <span class="bp-cell__bounds-label">行 最大</span>
          <span class="bp-cell__bounds-value" data-bounds="row">0</span>
        </span>
        <span class="bp-cell__bounds-item">
          <span class="bp-cell__bounds-label">列 最大</span>
          <span class="bp-cell__bounds-value" data-bounds="col">0</span>
        </span>
        <span class="bp-cell__bounds-item">
          <span class="bp-cell__bounds-label">层 最大</span>
          <span class="bp-cell__bounds-value" data-bounds="z">0</span>
        </span>
      </div>
      <div class="bp-cell__board-wrap">
        <div class="bp-cell__board">
          <div class="bp-cell__board-grid"></div>
        </div>
      </div>
    `;
    this._seqEl = /** @type {HTMLDivElement} */ (
      this.querySelector('.bp-cell__seq')
    );
    this._levelTextarea = /** @type {HTMLTextAreaElement} */ (
      this.querySelector('.bp-cell__level')
    );
    this._offsetTextarea = /** @type {HTMLTextAreaElement} */ (
      this.querySelector('.bp-cell__offset-str')
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
    // outer (`bp-cell__board`) 承担 padding / background / border；
    // inner (`bp-cell__board-grid`) 承担 grid 布局与 aspect-ratio。
    // 拆分原因：CSS aspect-ratio + box-sizing: border-box + 不对称 padding 会让
    // **content-box** 失去 `colCells:rowCells` 比例，导致 `1fr × 1fr` cell 变成
    // 长方形。把 padding 放到 outer 后，inner 永远是纯净的 `colCells:rowCells`
    // 容器，grid cell 才能稳定保持正方形。
    this._boardGridEl = /** @type {HTMLDivElement} */ (
      this.querySelector('.bp-cell__board-grid')
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
      } else if (act === 'copy-offset') {
        void this._copyOffsetStr();
      } else if (act === 'paste-offset') {
        void this._pasteOffsetStr();
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
        { row: 0, col: 0, z: 0, suit: 'c' },
        { row: 0, col: 1, z: 0, suit: 'c' },
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
    const offsetStr = this._offsetTextarea?.value.trim() ?? '';
    return {
      id: this.dataset.id,
      tags: this.readTags(),
      sourceLevelStr: this._sourceLevelStr,
      sourceOffsetStr: this._sourceOffsetStr,
      operations: this._operations.map((o) => ({ ...o })),
      levelStr,
      offsetStr,
      meta: { hadZAxisOperation: this._hadZ },
    };
  }

  /** @param {object} item */
  loadBundleItem(item) {
    this._sourceLevelStr = item.sourceLevelStr;
    this._sourceOffsetStr = item.sourceOffsetStr ?? '';
    this._operations = (item.operations ?? []).map((o) => ({ ...o }));
    this._hadZ = Boolean(item.meta?.hadZAxisOperation);
    this._levelTextarea.value = item.levelStr;
    if (this._offsetTextarea) {
      this._offsetTextarea.value = item.offsetStr ?? '';
    }
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

  async _copyOffsetStr() {
    this._setError('');
    const text = this._offsetTextarea?.value ?? '';
    if (!text) {
      this._emitToast('当前没有可复制的 offset 串。', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this._emitToast('已复制 offset 串到剪贴板', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._setError(`复制失败：${msg}（请检查浏览器权限）`);
      this._emitToast('复制失败，请检查浏览器权限', 'error');
    }
  }

  async _pasteOffsetStr() {
    this._setError('');
    if (!this._offsetTextarea) return;
    try {
      const text = await navigator.clipboard.readText();
      this._offsetTextarea.value = text;
      // 与 level 串同样的"会覆盖原始"提醒。
      if (this._sourceOffsetStr) {
        this._emitToast(
          '已粘贴 offset — 注意：点击「解码 / 应用」会覆盖当前的原始 offset',
          'warn',
        );
      } else {
        this._emitToast('已从剪贴板粘贴 offset', 'success');
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
    if (this._offsetTextarea) {
      this._offsetTextarea.value = this._sourceOffsetStr;
    }
    this._operations = [];
    this._hadZ = false;
    this._updateOpLog();
    this.applyDecode(false);
    this._emitToast('已重置为原始关卡（含 offset）', 'success');
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
    const { rowMin, rowMax, colMin, colMax, zMin, zMax } = getBounds(this._tiles);
    const rowCells = Math.max(1, rowMax - rowMin + 2);
    const colCells = Math.max(1, colMax - colMin + 2);
    const layers = Math.max(0, (zMax ?? 0) - (zMin ?? 0));
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
      // tile 实际宽度 = 2 grid cell + 1 gap（正方形）：
      const tileWidth = TILE_PX * 2 + GAP_PX;
      const tileHeight = TILE_PX * 2 + GAP_PX;
      // 水平像素 ← col 偏移；垂直像素 ← row 偏移。
      const offsetXPx = (t.col - colMin) * (TILE_PX + GAP_PX);
      const offsetYPx = (t.row - rowMin) * (TILE_PX + GAP_PX);
      let drawX = padLeft + offsetXPx;
      let drawY = padTop + offsetYPx;
      // 与屏幕渲染同语义：Z 偏移与 offset 各自由全局开关控制，可独立或叠加。
      if (enabled && layers > 0) {
        const zLevel = t.z - (zMin ?? 0);
        drawX += (zLevel * zoX * tileWidth) / 100;
        drawY += (zLevel * zoY * tileHeight) / 100;
      }
      if (this._offsetEnabled) {
        const offRec = this._offsetByAnchor.get(towerKey(t.row, t.col));
        if (offRec) {
          const [dRow, dCol] = OFFSET_DIRECTION_VECTORS[offRec.direction];
          const zRel = t.z - offRec.z;
          // 与屏幕渲染统一：单层增量 = (mag+1) × unitPct%，其中 unitPct%=unitPct/100。
          // unitPct=1（默认）时 step=(mag+1)/100，等价于旧的 OFFSET_UNIT × (mag+1)。
          const factor = (zRel * (offRec.magnitude + 1) * this._offsetUnitPct) / 100;
          drawX += dCol * factor * tileWidth;
          drawY += dRow * factor * tileHeight;
        }
      }
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
   * @param {boolean} resetSession 为 true 时清空操作记录并将当前串记为新的「源」（level + offset 同时重置）
   */
  applyDecode(resetSession) {
    this._setError('');
    const raw = this._levelTextarea.value.trim();
    const rawOffset = this._offsetTextarea?.value.trim() ?? '';
    try {
      this._tiles = fromLevelStr(raw);
      if (resetSession) {
        this._operations = [];
        this._hadZ = false;
        this._sourceLevelStr = raw;
        this._sourceOffsetStr = rawOffset;
      }
      this._updateOpLog();
      // offset 失败不影响 level 渲染，但要把错误清晰地报到 UI；
      // 渲染 board 时会读取 _offsetByAnchor，所以先决定它再 render。
      this._applyOffset(rawOffset);
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
   * 解析 + 校验 offset 串。
   *
   * - 空串清空 `_offsetByAnchor`，不报错；
   * - 任一阶段出错：清空 `_offsetByAnchor`、把错误写到 _errEl（与 level 串错误共用错误条），
   *   但**不抛**给调用方——避免一个 offset 笔误把整盘 level 渲染都打掉。
   *   错误同时通过 toast 提示一次，便于用户即时看到。
   *
   * @param {string} rawOffset
   */
  _applyOffset(rawOffset) {
    if (!rawOffset) {
      this._offsetRecords = [];
      this._offsetByAnchor = new Map();
      return;
    }
    try {
      const records = parseOffsetStr(rawOffset);
      this._offsetRecords = records;
      this._offsetByAnchor = applyOffsetsToTiles(this._tiles, records);
    } catch (e) {
      this._offsetRecords = [];
      this._offsetByAnchor = new Map();
      const msg = e instanceof Error ? e.message : String(e);
      this._setError(msg);
      this._emitToast(`offset 解析失败：${msg}`, 'error');
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
      // bounds 必须在 tiles **变换之前**算，再同时给 tile / offset 两个变换器使用——
      // 错位的 bounds 会让 offset 锚点与 tile 锚点对不上、offset 失效。
      const bounds = getFootprintCellBounds(this._tiles);
      this._tiles = applyBoardOperation(this._tiles, op);
      if (this._offsetRecords.length > 0) {
        const nextRecords = applyBoardOperationToOffsets(
          this._offsetRecords,
          op,
          bounds,
        );
        this._offsetRecords = nextRecords;
        // 重建锚点视图：tile 锚点已变、map key 必须重新算。
        this._offsetByAnchor = applyOffsetsToTiles(this._tiles, nextRecords);
        if (this._offsetTextarea) {
          this._offsetTextarea.value = serializeOffsetRecords(nextRecords);
        }
      }
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
   * 更新「行 / 列 / 层 最大值」状态行；传入 null 表示空棋盘（隐藏整行）。
   * @param {{ rowMax: number, colMax: number, zMax: number } | null} info
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
    setVal('row', info.rowMax);
    setVal('col', info.colMax);
    setVal('z', info.zMax);
  }

  _renderBoard() {
    const board = this._boardEl;
    const grid = this._boardGridEl;
    grid.innerHTML = '';
    if (!this._tiles.length) {
      grid.style.aspectRatio = 'auto';
      grid.style.gridTemplateRows = '';
      grid.style.gridTemplateColumns = '';
      const p = document.createElement('p');
      p.className = 'bp-cell__empty';
      p.textContent = '无牌（解码后显示）';
      grid.appendChild(p);
      this._renderBounds(null);
      return;
    }

    const { rowMin, rowMax, colMin, colMax, zMin, zMax } = getBounds(this._tiles);
    // 显示的「最大值」按整盘可达坐标计：tile 锚点 (row, col) 占 2×2 单元格，
    // 故 row 方向最大可达 rowMax + 2、col 方向 colMax + 2；z 是层号（从 0 起），层数 = zMax + 1。
    this._renderBounds({
      rowMax: rowMax + 2,
      colMax: colMax + 2,
      zMax: zMax + 1,
    });
    const rowCells = Math.max(1, rowMax - rowMin + 2);
    const colCells = Math.max(1, colMax - colMin + 2);
    grid.style.gridTemplateRows = `repeat(${rowCells}, 1fr)`;
    grid.style.gridTemplateColumns = `repeat(${colCells}, 1fr)`;
    grid.style.aspectRatio = `${colCells} / ${rowCells}`;
    // outer 只负责 padding/背景，结构上**不**参与 grid——确保它不会因 grid 而受 inner 大小拖动。
    void board;

    const order = sortTiles(this._tiles);
    let i = 0;
    for (const t of order) {
      const div = document.createElement('div');
      div.className = 'bp-tile';
      div.style.gridRow = `${t.row - rowMin + 1} / span 2`;
      div.style.gridColumn = `${t.col - colMin + 1} / span 2`;
      div.style.zIndex = String(100 + t.z * 10 + (i += 1));
      div.style.setProperty('--bp-tile-z', String(t.z - (zMin ?? 0)));
      // 柱子级 offset：本质是**该柱子私有的 Z 偏移向量**——
      // 与全局 Z 偏移同质（"每升一层多挪一份"），仅作用范围限于该 (row, col) 这一柱。
      //
      //   tile_offset = (t.z - offRec.z) × dirVec × (mag + 1) × unitPct%
      //
      // - offRec.z 是柱子基准层（推荐 min(z) of tower）；
      // - 这里只注入**无量纲的"方向 × 档位 × 层差"**，单位百分比由 CSS 端
      //   `var(--bp-offset-unit-pct) × 1%` 统一缩放——unitPct 变化时所有 tile
      //   transform 自动重排，无需重建 DOM。
      // - 永远注入 `--bp-tile-offset-x/y`，最终是否生效由 host 开关控制（main.css）。
      // - 与全局 Z 偏移可叠加（在 .bp-tile 的 transform calc 中合成）。
      const offRec = this._offsetByAnchor.get(towerKey(t.row, t.col));
      if (offRec) {
        const [dRow, dCol] = OFFSET_DIRECTION_VECTORS[offRec.direction];
        const zRel = t.z - offRec.z;
        const stepUnits = zRel * (offRec.magnitude + 1);
        div.style.setProperty('--bp-tile-offset-x', String(dCol * stepUnits));
        div.style.setProperty('--bp-tile-offset-y', String(dRow * stepUnits));
      } else {
        div.style.setProperty('--bp-tile-offset-x', '0');
        div.style.setProperty('--bp-tile-offset-y', '0');
      }
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
      face.title = `z${t.z} 行${t.row} 列${t.col} ${t.suit || ''}`.trim();

      div.appendChild(imgBase);
      div.appendChild(face);
      grid.appendChild(div);
    }
    this._updateBoardZOffsetStyle();
  }
}

customElements.define('board-preview-cell', BoardPreviewCell);
