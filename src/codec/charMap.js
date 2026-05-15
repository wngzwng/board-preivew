/**
 * 与 Python `.common` 中 `char_to_number` / `number_to_char` 对齐。
 *
 * - `0`–`9` → 0–9
 * - `A`–`Z` → 10–35
 * - `a`–`z` → 36–61
 */

/** @param {string} char */
export function charToNumber(char) {
  if (char.length !== 1) {
    throw new Error(`非法字符长度: 期望 1 个字符，得到 ${char.length}`);
  }
  const c = char;
  if (c >= '0' && c <= '9') {
    return c.charCodeAt(0) - '0'.charCodeAt(0);
  }
  if (c >= 'A' && c <= 'Z') {
    return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
  }
  if (c >= 'a' && c <= 'z') {
    return c.charCodeAt(0) - 'a'.charCodeAt(0) + 36;
  }
  throw new Error(`非法字符: "${c}"`);
}

/** @param {number} number */
export function numberToChar(number) {
  if (!Number.isInteger(number)) {
    throw new Error(`非法数值: ${number}`);
  }
  if (number >= 0 && number <= 9) {
    return String.fromCharCode(number + '0'.charCodeAt(0));
  }
  if (number >= 10 && number <= 35) {
    return String.fromCharCode(number - 10 + 'A'.charCodeAt(0));
  }
  if (number >= 36 && number <= 61) {
    return String.fromCharCode(number - 36 + 'a'.charCodeAt(0));
  }
  throw new Error(`数值越界: ${number}`);
}
