/**
 * 几何操作 → 单字符（用于操作记录串，与导出 operations 顺序一致）。
 * @see docs/components/board-operations.md
 */
export const BOARD_OP_GLYPH = {
  rotate_left: 'L',
  rotate_right: 'R',
  mirror_x: 'X',
  mirror_y: 'Y',
  flip_z: 'Z',
};

/** 人类可读说明（与字符表一致） */
export const BOARD_OP_GLYPH_LEGEND =
  'L=左转 R=右转 X=X镜像 Y=Y镜像 Z=Z层反转';

/**
 * @param {Array<{ type: string }>} operations
 * @returns {string}
 */
export function operationsToGlyphString(operations) {
  return operations
    .map(
      (o) =>
        BOARD_OP_GLYPH[
          /** @type {keyof typeof BOARD_OP_GLYPH} */ (o.type)
        ] ?? '?',
    )
    .join('');
}
