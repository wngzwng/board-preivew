#!/usr/bin/env node
/**
 * 单文件打包器：把 `index.html` 引用的 CSS、ES Module 源码与图片资源
 * 全部内联到 `dist/index.html`，产出可直接双击或部署的单文件 Web 应用。
 *
 * 设计目标：
 * - 零运行时依赖（项目宪法）：只用 Node 自带的 fs / path / url
 * - 与现有源码兼容：识别项目里出现过的 import / export 形式
 * - 失败时给出可定位的错误信息（文件路径 + 原因）
 *
 * 用法：
 *   node scripts/bundle.js                  → 写到 dist/index.html
 *   node scripts/bundle.js --out=foo.html   → 写到指定文件
 *
 * 注意：
 * - 本打包器只处理项目当前的 ESM 形态：相对路径 import、命名 export、副作用
 *   import；不处理 `export default`、`import * as ns`、动态 `import()`、
 *   `export { a as b }`、`export const a = 1, b = 2;` 等本项目未使用的形式。
 *   若未来引入这些写法，请同步在 transformModuleSource() 里扩展。
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep as PATH_SEP } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');

const ENTRY_HTML = resolve(ROOT, 'index.html');
const ENTRY_JS = resolve(ROOT, 'src/main.js');
const CSS_PATH = resolve(ROOT, 'styles/main.css');
const ASSETS_DIR = resolve(ROOT, 'src/assets');
const ASSETS_PREFIX = 'src/assets';

/**
 * 已知的二进制资源后缀 → MIME 类型。新增格式只需在这里扩展。
 */
const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/* ---------------- CLI ---------------- */

function parseArgs(argv) {
  const args = { out: resolve(ROOT, 'dist/index.html') };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--out=')) {
      args.out = resolve(ROOT, a.slice('--out='.length));
    } else if (a === '-h' || a === '--help') {
      printHelpAndExit(0);
    } else {
      console.error(`未知参数: ${a}`);
      printHelpAndExit(1);
    }
  }
  return args;
}

function printHelpAndExit(code) {
  process.stdout.write(
    [
      '用法: node scripts/bundle.js [--out=<path>]',
      '',
      '  --out=<path>   输出文件路径（相对项目根；默认 dist/index.html）',
      '  -h, --help     显示帮助',
      '',
    ].join('\n'),
  );
  process.exit(code);
}

/* ---------------- Path helpers ---------------- */

function pathToId(absPath) {
  return `/${relative(ROOT, absPath).split(PATH_SEP).join('/')}`;
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) {
    throw new Error(
      `${pathToId(fromFile)}: 暂不支持非相对 import "${specifier}"`,
    );
  }
  return resolve(dirname(fromFile), specifier);
}

/* ---------------- JS module transform ---------------- */

/**
 * 解析单个模块源码，提取相对依赖并把 import/export 改写为
 * 「读写共享对象 __M[id] 的 __exports」的形式。
 *
 * @param {string} absPath 模块绝对路径
 * @param {string} source 模块源码
 * @returns {{ deps: string[], transformed: string }}
 */
function transformModuleSource(absPath, source) {
  const deps = [];

  // 1) import 改写
  //    - import './foo.js';                       → 删除（拓扑顺序保证已加载）
  //    - import { a, b } from './foo.js';         → const { a, b } = __M['<id>'];
  //    - import {\n a,\n b,\n} from './foo.js';   → 同上
  //
  // 注意：`[\s\S]*?` 用非贪婪允许跨行；不使用 ^$ 锚点，靠 `import` 与 `;?`
  // 的形态唯一性匹配，本项目源码中不会在字符串/注释里出现该形态。
  const importRe =
    /import\s+(?:\{([\s\S]*?)\}\s+from\s+)?['"]([^'"]+)['"]\s*;?/g;

  let out = source.replace(importRe, (_, namedClause, specifier) => {
    const dep = resolveImport(absPath, specifier);
    deps.push(dep);

    if (!namedClause) {
      return `/* inlined side-effect import: ${specifier} */`;
    }
    const names = namedClause
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.some((n) => / as /.test(n))) {
      throw new Error(
        `${pathToId(absPath)}: 暂不支持 "import { a as b }" 写法`,
      );
    }
    return `const { ${names.join(', ')} } = __M[${JSON.stringify(
      pathToId(dep),
    )}];`;
  });

  // 2) export 解析
  //
  // 收集 export 标识符（仅支持：function、function*、async function、
  // const、let、var、class；不支持单行多变量与 export {}/default 形态）。
  const declRe =
    /\bexport\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+(\w+)/g;
  const exportNames = [];
  let m;
  while ((m = declRe.exec(out)) !== null) {
    exportNames.push(m[1]);
  }

  // 检测不支持的 export 形态，提前报错而不是静默丢失
  const unsupportedRe = /\bexport\s+(\{|default\b|\*\s+from)/;
  const bad = out.match(unsupportedRe);
  if (bad) {
    throw new Error(
      `${pathToId(absPath)}: 暂不支持的 export 形态 "${bad[0]}"`,
    );
  }

  // 去掉 export 关键字（保留其后的声明本体）
  out = out.replace(
    /\bexport\s+((?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+)/g,
    '$1',
  );

  // 3) 末尾把 exports 挂到 __exports
  const tail = exportNames
    .map((n) => `  __exports[${JSON.stringify(n)}] = ${n};`)
    .join('\n');

  return {
    deps: Array.from(new Set(deps)),
    transformed: tail ? `${out}\n${tail}\n` : `${out}\n`,
  };
}

/* ---------------- Module graph & topological order ---------------- */

/**
 * 从 entryAbs 出发，DFS 加载所有相对依赖；后序遍历即为拓扑序
 * （被依赖者先于依赖者）。
 *
 * @param {string} entryAbs
 * @returns {{ order: string[], modules: Map<string, { transformed: string }> }}
 */
function buildGraph(entryAbs) {
  /** @type {Map<string, { transformed: string }>} */
  const modules = new Map();
  /** @type {string[]} */
  const order = [];
  /** @type {Set<string>} */
  const onStack = new Set();

  function visit(absPath) {
    if (modules.has(absPath)) return;
    if (onStack.has(absPath)) {
      throw new Error(`检测到循环依赖: ${pathToId(absPath)}`);
    }
    onStack.add(absPath);

    let source;
    try {
      source = readFileSync(absPath, 'utf8');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`读取模块失败 ${pathToId(absPath)}: ${msg}`);
    }
    const { deps, transformed } = transformModuleSource(absPath, source);
    for (const dep of deps) visit(dep);

    modules.set(absPath, { transformed });
    order.push(absPath);
    onStack.delete(absPath);
  }

  visit(entryAbs);
  return { order, modules };
}

/* ---------------- Bundle composition ---------------- */

function wrapAsModule(absPath, transformed) {
  const id = pathToId(absPath);
  return [
    `__M[${JSON.stringify(id)}] = (() => {`,
    `  const __exports = {};`,
    transformed,
    `  return __exports;`,
    `})();`,
  ].join('\n');
}

/**
 * 把整个 ESM 依赖图打成一段 IIFE：
 * - 共享 __M 字典模拟模块缓存
 * - 拓扑序依次执行每个模块的 IIFE，结果挂到 __M
 *
 * @param {string[]} order
 * @param {Map<string, { transformed: string }>} modules
 * @param {string} [assetPrelude] 资源表 prelude（可空）
 */
function composeJsBundle(order, modules, assetPrelude = '') {
  const blocks = order.map((p) => wrapAsModule(p, modules.get(p).transformed));
  const parts = ['/* 由 scripts/bundle.js 自动生成 — 请勿手工修改 */'];
  if (assetPrelude) parts.push(assetPrelude);
  parts.push('(() => {', '  const __M = Object.create(null);', ...blocks, '})();');
  return parts.join('\n\n');
}

/* ---------------- Assets (binary → data URL) ---------------- */

function extOf(p) {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i + 1).toLowerCase() : '';
}

/**
 * 递归扫描 `src/assets/` 下所有受支持后缀的二进制资源，构建
 *
 *   refPath（仓库根相对的 POSIX 路径，例如 `src/assets/tilebase_Cloud.png`）
 *     ↓
 *   `data:<mime>;base64,...`
 *
 * 映射表。bundle 启动时把它注入到 `globalThis.__BP_ASSETS`，由
 * `src/assets/tileSources.js` 的 fallback 逻辑接管，自动把构造出的
 * 相对路径替换为内联 data URL；开发期 `__BP_ASSETS` 不存在，行为不变。
 *
 * @returns {Map<string, { dataUrl: string, size: number }>}
 */
function collectAssets() {
  /** @type {Map<string, { dataUrl: string, size: number }>} */
  const assets = new Map();

  function walk(absDir) {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`扫描 ${pathToId(absDir)} 失败: ${msg}`);
    }
    for (const entry of entries) {
      const abs = resolve(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extOf(entry.name);
      const mime = MIME_BY_EXT[ext];
      if (!mime) continue;

      let buf;
      try {
        buf = readFileSync(abs);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`读取资源失败 ${pathToId(abs)}: ${msg}`);
      }
      const refPath = relative(ROOT, abs).split(PATH_SEP).join('/');
      assets.set(refPath, {
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        size: buf.length,
      });
    }
  }

  try {
    statSync(ASSETS_DIR);
  } catch {
    return assets; // 没有资源目录也允许（极简项目）
  }
  walk(ASSETS_DIR);
  return assets;
}

/**
 * 生成 bundle 顶部要执行的 prelude：把资源表挂到 globalThis，供
 * tileSources.js 的 fallback 查表。
 * @param {Map<string, { dataUrl: string }>} assets
 */
function composeAssetPrelude(assets) {
  if (assets.size === 0) return '';
  const dict = {};
  for (const [refPath, info] of assets) {
    dict[refPath] = info.dataUrl;
  }
  return [
    '/* 内联资源表（由 scripts/bundle.js 注入） */',
    `globalThis.__BP_ASSETS = ${JSON.stringify(dict)};`,
  ].join('\n');
}

/* ---------------- HTML stitching ---------------- */

/**
 * 把 `</script>`、`</style>` 等闭合标签转义，避免被嵌入 HTML 时
 * 提前结束所在的标签解析。
 */
function escapeForHtml(text) {
  return text
    .replace(/<\/script>/gi, '<\\/script>')
    .replace(/<!--/g, '<\\!--')
    .replace(/<\/style>/gi, '<\\/style>');
}

function inlineIntoHtml(htmlSource, cssText, jsBundle) {
  const linkRe =
    /<link\b[^>]*\brel=["']?stylesheet["']?[^>]*\bhref=["']\.\/styles\/main\.css["'][^>]*\/?>/i;
  const scriptRe =
    /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\.\/src\/main\.js["'][^>]*><\/script>/i;

  if (!linkRe.test(htmlSource)) {
    throw new Error('在 index.html 中未找到指向 ./styles/main.css 的 <link>');
  }
  if (!scriptRe.test(htmlSource)) {
    throw new Error(
      '在 index.html 中未找到指向 ./src/main.js 的 <script type="module">',
    );
  }

  return htmlSource
    .replace(linkRe, `<style>\n${escapeForHtml(cssText)}\n</style>`)
    .replace(
      scriptRe,
      `<script type="module">\n${escapeForHtml(jsBundle)}\n</script>`,
    );
}

/* ---------------- Reporting ---------------- */

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

function printReport({ moduleOrder, modules, assets, out, totalBytes }) {
  console.log('— 模块（拓扑序）—');
  for (const abs of moduleOrder) {
    const id = pathToId(abs);
    const size = Buffer.byteLength(modules.get(abs).transformed, 'utf8');
    console.log(`  ${id.padEnd(48, ' ')} ${formatBytes(size)}`);
  }
  if (assets.size > 0) {
    console.log('— 资源 —');
    for (const [refPath, info] of assets) {
      console.log(`  ${refPath.padEnd(48, ' ')} ${formatBytes(info.size)}`);
    }
  }
  console.log('— 输出 —');
  console.log(`  ${relative(ROOT, out)}   ${formatBytes(totalBytes)}`);
}

/* ---------------- Main ---------------- */

function main() {
  const { out } = parseArgs(process.argv);

  let htmlSource;
  let cssText;
  try {
    htmlSource = readFileSync(ENTRY_HTML, 'utf8');
    cssText = readFileSync(CSS_PATH, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`读取入口文件失败: ${msg}`);
    process.exit(1);
  }

  let order;
  let modules;
  try {
    ({ order, modules } = buildGraph(ENTRY_JS));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`构建模块图失败: ${msg}`);
    process.exit(1);
  }

  let assets;
  try {
    assets = collectAssets();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`收集资源失败: ${msg}`);
    process.exit(1);
  }

  const assetPrelude = composeAssetPrelude(assets);
  const bundle = composeJsBundle(order, modules, assetPrelude);

  const finalHtml = inlineIntoHtml(htmlSource, cssText, bundle);

  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, finalHtml, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`写出 ${out} 失败: ${msg}`);
    process.exit(1);
  }

  printReport({
    moduleOrder: order,
    modules,
    assets,
    out,
    totalBytes: Buffer.byteLength(finalHtml, 'utf8'),
  });
}

main();
