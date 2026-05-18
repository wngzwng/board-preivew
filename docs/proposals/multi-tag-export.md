# 提案：多标签导出

> **状态**：📝 Proposed（**未实现**，本文档仅作设计记录）
> **范围**：导入导出组件 — CSV 导出按标签过滤
> **关联**：[导入导出组件](../components/io.md) · [Board 操作集](../components/board-operations.md)

## 1. 背景与现状

当前"按标签导出"由 [`board-preview-app.js`](../../src/components/board-preview-app.js) 的 `exportCsvByTag` 实现，逻辑是**单关键字 + 子串包含**：

```js
exportCsvByTag() {
  const tag = window.prompt('要包含的标签（任一匹配即导出该预览框）:', '');
  // ...
  const needle = tag.trim();
  const entries = this._exportEntries().filter((e) =>
    e.item.tags.some((t) => t.includes(needle)),
  );
  // ...
}
```

行为：
- 弹一个 `prompt`，只接受单一字符串 `needle`
- 用 `String.prototype.includes` 对 cell 的**每一个**标签做子串匹配，任一命中即导出
- prompt 的提示语"任一匹配即导出该预览框"指的是 cell 内部的多个标签里只要有一条命中，而不是支持多个关键字

**不支持**的语义：
- 多关键字 OR：`简单` 或 `测试` 任一命中即导出
- 多关键字 AND：必须同时带 `简单` 和 `已审`
- NOT 排除：导出时排除 `废弃`
- 精确匹配（vs. 子串）：避免 `简单` 误命中 `简单挑战`

## 2. 目标语义

支持三种过滤语义，可叠加组合：

| 语义 | 命中条件 | 备注 |
|------|----------|------|
| **OR**（任一命中） | cell 标签集合与"包含"列表的交集非空 | 默认主语义，最常用 |
| **AND**（必须全部命中） | "必须"列表是 cell 标签集合的子集 | 用于严格筛选 |
| **NOT**（排除） | cell 标签集合与"排除"列表的交集为空 | 与 OR/AND 叠加 |

**匹配模式**：
- **精确匹配**（推荐默认）：标签字符串 `===` 才算命中
- 子串匹配作为可选项，沿用当前行为以避免破坏既有工作流

形式化：给定 cell 标签集合 `T`，过滤参数 `{ any: A, all: M, none: N }`，命中条件为：

```
(A.size === 0 || A.intersects(T))   // OR 或 留空表示不约束
&& M.isSubsetOf(T)                  // AND 全部存在
&& !N.intersects(T)                 // NOT 全部不存在
```

## 3. UI 方案

### 方案 A：约定语法 prompt（最小改动）

复用现有 `window.prompt`，约定分隔符语法：

| 符号 | 语义 |
|------|------|
| `,`（中英逗号皆可） | OR，例：`简单, 测试` |
| `+` 或空格 | AND，例：`简单 + 已审` 或 `简单 已审` |
| `-` 前缀 | NOT，例：`-废弃` |
| `"abc"` 引号包裹 | 精确匹配（含逗号/空格的标签） |

示例：`简单, 测试 + 已审, -废弃` → "（含简单 或 含测试） 且 含已审 且 不含废弃"

**取舍**：
- ✅ 改动小，0 新增 UI 元素
- ❌ 用户需要学习并记忆语法
- ❌ 含特殊字符的标签（罕见）需要引号转义，复杂度上升

### 方案 B：弹窗多选面板（更友好）

新增 `<dialog>` 或自定义弹层组件，列出当前工作区里所有出现过的标签 + 预设标签：

```
要导出的预览框需满足：
┌─ 任一标签匹配（OR）─────────────────┐
│ ☐ 简单    ☐ 中等    ☐ 困难          │
│ ☐ 测试    ☐ 已审    ...             │
├─ 必须全部包含（AND）────────────────┤
│ ☐ 已审    ☐ 复检通过                │
├─ 排除（NOT）────────────────────────┤
│ ☐ 废弃    ☐ 草稿                    │
└─────────────────────────────────────┘
匹配模式：(•) 精确    ( ) 子串
                              [导出] [取消]
```

**取舍**：
- ✅ 零学习成本，标签从已知集合中选择，避免拼写错
- ✅ 可视化看到每条过滤条件
- ❌ 需要新增组件、样式与无障碍交互
- ❌ 工作区标签很多时面板会变长（可加搜索框）

### 建议

**默认采取方案 B**；若希望先快速上线再迭代，可先做方案 A，等需求成熟后替换。两个方案的**过滤核心**（第 2 节的命中条件）完全相同，只是参数来源不同，便于后续替换 UI。

## 4. 实现要点

### 4.1 公共过滤函数

把过滤逻辑从 `exportCsvByTag` 抽出，独立成纯函数便于测试与复用（按标签批量统计、按标签可视化染色等也可以复用）：

```js
/**
 * @param {string[]} cellTags 该预览框的标签
 * @param {{ any?: string[], all?: string[], none?: string[], mode?: 'exact'|'substring' }} f
 * @returns {boolean}
 */
function matchTagFilter(cellTags, f) {
  const mode = f.mode ?? 'exact';
  const match = (needle, t) =>
    mode === 'exact' ? needle === t : t.includes(needle);
  const any = f.any ?? [];
  const all = f.all ?? [];
  const none = f.none ?? [];
  if (any.length && !any.some((n) => cellTags.some((t) => match(n, t)))) {
    return false;
  }
  if (!all.every((n) => cellTags.some((t) => match(n, t)))) {
    return false;
  }
  if (none.some((n) => cellTags.some((t) => match(n, t)))) {
    return false;
  }
  return true;
}
```

放在 `src/io/tagFilter.js`，由 `board-preview-app.js` 与单测共同消费。

### 4.2 文件名约定

当前实现把单一关键字拼到文件名 `board-preview-${needle}.csv`；多标签后需要新规则：

- 若过滤总词数 ≤ 3，按词拼接：`board-preview-tags-A-B-C.csv`
- 否则用 `board-preview-tags-<n>cond.csv` + 配套生成一个 `*.filter.json` 同步导出过滤条件（可选）
- 含特殊字符（`/`、空格、引号等）的标签做文件名转义（替换为 `_`）

### 4.3 错误与边界

| 场景 | 行为 |
|------|------|
| 三组过滤都为空 | 视为"全部导出"，给出一次确认（或直接走 `exportCsvAll` 路径） |
| OR 列表中的某个标签当前工作区没人用 | 不报错，沿用 OR 语义自然结果为空集 |
| 命中结果为 0 条 | 弹提示"没有匹配的预览框"，不下载 |
| 仅 NOT 列表非空 | 等价于"除了带这些标签的，其它都导出" |
| 标签有空白/大小写不一致（如 `简单` vs `简单 `） | 比较前先 `trim()`；大小写按当前实现保持区分（与现有标签存储一致） |

### 4.4 与 JSON 导出的一致性

若未来 JSON 全量导出也加按标签过滤，应**共用同一个 `matchTagFilter` 与过滤参数对象**，避免 CSV 与 JSON 行为漂移。

## 5. 验收标准

实现完成后，至少覆盖以下用例（建议作为单测放在 `test/tagFilter.test.js`）：

1. 仅 OR：`{ any: ['A', 'B'] }`，cell 含 `[A]` 命中、含 `[C]` 不命中
2. 仅 AND：`{ all: ['A', 'B'] }`，cell 含 `[A, B, C]` 命中、含 `[A]` 不命中
3. 仅 NOT：`{ none: ['X'] }`，cell 含 `[X]` 不命中、含 `[Y]` 命中
4. 组合：`{ any: ['A'], all: ['B'], none: ['X'] }`，cell `[A, B]` 命中、`[A, B, X]` 不命中
5. 三个列表都空 → 全部命中
6. `mode='exact'` vs `mode='substring'` 的差异
7. 标签字符串前后空白不影响命中

## 6. 风险与回退

- **风险**：现有用户的"单关键字 + 子串"工作流被打破。
- **回退策略**：实现时默认 `mode='exact'` + 单一 OR 列表，与单关键字精确匹配保持兼容；保留一个"模糊匹配"勾选回到子串语义。
- **数据迁移**：标签存储格式不变（仍是 `string[]`），无需迁移。

## 7. 决策记录（待回填）

| 项 | 选项 | 决定 | 时间 |
|----|------|------|------|
| UI 形式 | 方案 A / B | 待定 | — |
| 默认匹配模式 | 精确 / 子串 | 待定 | — |
| 是否同步改造 JSON 导出 | 是 / 否 | 待定 | — |
| 文件名规则 | 见 4.2 | 待定 | — |

实现后请把本表填好并把"状态"改为 ✅ Implemented，附 commit / PR 链接。
