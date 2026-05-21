#!/usr/bin/env node
/**
 * 从大 CSV 中抽取指定列，输出体积更小的子集 CSV。
 *
 * 设计目标：
 * - **流式处理**：Node `readline` 按行读，逐行写出；不一次性把整个文件读到内存。
 *   原始 CSV 可达数百 MB（用 FileReader.readAsText 会 OOM 或静默返回空），
 *   这是它无法直接在浏览器里导入的根因。
 * - **零运行时依赖**：与 `bundle.js` 一致，只用 Node 内置模块。
 * - **保留 CSV 引号语义**：抽取的字段如果含 `,` / 换行 / 引号，重新转义后再写出。
 *
 * 用法：
 *   node scripts/extract-csv-columns.js <输入.csv> [选项]
 *
 * 选项：
 *   --cols=Index,Content      要保留的列名（逗号分隔，按出现顺序），默认 Index,Content
 *   --out=path                输出文件路径，默认 <输入同名>.subset.csv
 *
 * 示例：
 *   node scripts/extract-csv-columns.js ~/Desktop/big.csv \
 *     --cols=Index,Content --out=tools/board-content.csv
 *
 * 注意：本脚本假设 CSV 用 LF / CRLF 作为行分隔符，且**字段内的换行**已经被
 * 上游正确处理为带引号包围的内容。`readline` 默认按物理行切，含嵌入换行的
 * 字段会被错误拆开——若上游产生此类数据，需要替换为字符级流式解析器。
 * 本项目当前数据源（关卡 Content 列是单行字符串）满足这个前提。
 */

import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, basename, dirname, extname, join } from 'node:path';

/** @typedef {{ inputPath: string, cols: string[], outputPath: string }} Options */

/**
 * 解析命令行参数。失败时打印用法并退出码 1。
 * @returns {Options}
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  /** @type {string | undefined} */
  let inputPath;
  let cols = ['Index', 'Content'];
  /** @type {string | undefined} */
  let outputPath;
  for (const arg of argv) {
    if (arg.startsWith('--cols=')) {
      cols = arg
        .slice('--cols='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (cols.length === 0) {
        throw new Error('--cols 不能为空');
      }
    } else if (arg.startsWith('--out=')) {
      outputPath = arg.slice('--out='.length);
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数：${arg}`);
    } else if (!inputPath) {
      inputPath = arg;
    } else {
      throw new Error(`重复的输入路径：${arg}`);
    }
  }
  if (!inputPath) {
    throw new Error('缺少输入 CSV 路径');
  }
  const resolvedInput = resolve(process.cwd(), inputPath);
  if (!outputPath) {
    const base = basename(resolvedInput, extname(resolvedInput));
    outputPath = join(dirname(resolvedInput), `${base}.subset.csv`);
  } else {
    outputPath = resolve(process.cwd(), outputPath);
  }
  return { inputPath: resolvedInput, cols, outputPath };
}

function printUsage() {
  const usage = [
    '用法: node scripts/extract-csv-columns.js <输入.csv> [选项]',
    '',
    '选项:',
    '  --cols=A,B,C       要保留的列名（按出现顺序），默认 Index,Content',
    '  --out=path         输出 CSV 路径，默认 <输入同名>.subset.csv',
    '',
    '示例:',
    '  node scripts/extract-csv-columns.js big.csv --cols=Index,Content --out=tools/small.csv',
  ].join('\n');
  process.stderr.write(`${usage}\n`);
}

/**
 * 解析**单行** CSV 为字段数组。支持 `"..."` 包围（含 `""` 转义）。
 *
 * 不处理"字段内嵌入换行"——这种字段必须在上游已合并到单行；
 * 本项目的数据源 Content 列保证单行，简化逻辑、性能最高。
 *
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

/** @param {string} s */
function escapeCsvField(s) {
  const t = String(s);
  if (/[",\r\n]/.test(t)) {
    return `"${t.replace(/"/g, '""')}"`;
  }
  return t;
}

/**
 * 流式抽取主流程。
 * @param {Options} opts
 */
async function run(opts) {
  const { inputPath, cols, outputPath } = opts;
  const inputSize = statSync(inputPath).size;
  process.stderr.write(
    `输入: ${inputPath}\n` +
      `大小: ${formatSize(inputSize)}\n` +
      `保留列: ${cols.join(', ')}\n` +
      `输出: ${outputPath}\n\n`,
  );

  const rl = createInterface({
    input: createReadStream(inputPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  const writer = createWriteStream(outputPath, { encoding: 'utf-8' });

  /** @type {number[] | null} */
  let colIndices = null;
  let lineNo = 0;
  let kept = 0;
  let bytes = 0;
  const reportEvery = 10_000;
  const startedAt = Date.now();

  for await (const line of rl) {
    lineNo++;
    const fields = parseCsvLine(line);
    if (colIndices === null) {
      // 第一行：表头。把请求的列名映射到索引；缺列即抛错（fail-fast）。
      const lookup = new Map(
        fields.map((name, i) => [name.trim(), i]),
      );
      colIndices = cols.map((name) => {
        const i = lookup.get(name);
        if (i === undefined) {
          throw new Error(
            `表头中未找到列「${name}」；已知列：${fields.slice(0, 20).join(', ')}${fields.length > 20 ? ' …' : ''}`,
          );
        }
        return i;
      });
      const headerLine = `${cols.map(escapeCsvField).join(',')}\n`;
      if (!writer.write(headerLine)) {
        await drain(writer);
      }
      bytes += Buffer.byteLength(headerLine, 'utf-8');
      continue;
    }
    const picked = colIndices.map((i) => fields[i] ?? '');
    const out = `${picked.map(escapeCsvField).join(',')}\n`;
    if (!writer.write(out)) {
      await drain(writer);
    }
    bytes += Buffer.byteLength(out, 'utf-8');
    kept++;
    if (kept % reportEvery === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      process.stderr.write(
        `  已处理 ${kept} 行，输出 ${formatSize(bytes)}，耗时 ${elapsed}s\n`,
      );
    }
  }

  await new Promise((res) => writer.end(res));
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stderr.write(
    `\n完成：读取 ${lineNo} 行，输出 ${kept} 条数据行，` +
      `共 ${formatSize(bytes)}（压缩比 ${((bytes / inputSize) * 100).toFixed(2)}%），耗时 ${elapsed}s\n`,
  );
}

/** @param {import('node:fs').WriteStream} stream */
function drain(stream) {
  return new Promise((res) => stream.once('drain', res));
}

/** @param {number} bytes */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

try {
  const opts = parseArgs();
  await run(opts);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`错误: ${msg}\n`);
  process.exit(1);
}
