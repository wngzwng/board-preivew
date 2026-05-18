/**
 * 标签视觉语言：把任意 tag 字符串映射成一个稳定 HSL 色相。
 *
 * 设计要点：
 * - 输入相同永远得到相同色相（chip / 统计行 / 导出浮层三处一致）
 * - 仅控制色相 H，亮度 / 饱和度由 CSS 派生，保证暗色主题对比度有底线
 * - 整体加 30° 偏移以避开 UI 主色相（约 145° 绿，与「成功 toast」相邻）
 */

const HUE_OFFSET = 30;

/**
 * 计算 tag 字符串对应的 HSL 色相值（0-359 整数）。
 * 空字符串返回 0，避免下游 CSS 拿到 NaN。
 *
 * @param {string} tag
 * @returns {number}
 */
export function tagHue(tag) {
  const s = String(tag ?? '');
  if (!s) return 0;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return ((Math.abs(h) % 360) + HUE_OFFSET) % 360;
}
