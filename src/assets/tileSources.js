/**
 * 花色字符 → 牌面贴图（可按项目扩展）。
 * 资源位于 `src/assets/`：底板 `tilebase_<Variant>.png`（如 tilebase_Cloud.png），
 * 可选牌面 `tilebase_card_<Variant>.png`（当前默认渲染只用底板，花色由文字叠加）。
 */

/** 资源根目录（相对 `index.html`） */
export const ASSETS_BASE = 'src/assets';

/** @param {string} suit 单字符或其它（取首字符尝试匹配） */
export function resolveTileVariant(suit) {
  const ch = suit ? suit[0] : '';
  const map = {
    c: 'Cloud',
    C: 'Cloud',
    云: 'Cloud',
  };
  return map[ch] ?? 'Cloud';
}

/** @param {string} suit @returns {{ base: string, card: string }} */
export function tileAssetPaths(suit) {
  const v = resolveTileVariant(suit);
  const base = `${ASSETS_BASE}/tilebase_${v}.png`;
  const card = `${ASSETS_BASE}/tilebase_card_${v}.png`;
  // 打包后由 scripts/bundle.js 注入 `globalThis.__BP_ASSETS`，
  // 把相对路径映射为内联的 data URL；开发期此对象不存在，走原相对路径。
  const table = /** @type {Record<string, string> | undefined} */ (
    /** @type {any} */ (globalThis).__BP_ASSETS
  );
  if (table) {
    return { base: table[base] ?? base, card: table[card] ?? card };
  }
  return { base, card };
}
