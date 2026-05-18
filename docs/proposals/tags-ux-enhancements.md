# 提案：标签分类与展示的体验提升

> **状态**：📌 Planned — 多项已确认实施（详见 §6 决策记录）；本节列出**已审议、未落地**的需求。落地后请把对应项标记为 ✅ Implemented 并附 commit / PR。
> **范围**：渲染组件 — 预览框（`board-preview-cell`）与顶层 App（`board-preview-app`）中与「标签」相关的 UI
> **关联**：[渲染组件](../components/render.md) · [导入导出组件](../components/io.md) · [多标签导出](./multi-tag-export.md)

## 0. 已确认实施清单（2026-05-18）

| 编号 | 主题 | 决议 |
|------|------|------|
| D1 | 禁用自定义标签 + 删除拦截 | 实施（见 §3.4） |
| B1 | 标签稳定颜色哈希 | 实施（见 §3.2） |
| B4 | 顶部预设标签使用计数 chip 行 | 实施（见 §3.2） |
| C2 | 标签筛选视图 | 实施，UI 上提供 **OR/AND 切换**；**导出始终走全集**，不受筛选影响（见 §3.3） |
| — | 「按标签导出」多选浮层 | 在 [multi-tag-export.md](./multi-tag-export.md) 落实；**新增按钮并保留旧 prompt 入口** |

未列入本次实施的 A1 / A2 / A3 / B2 / B3 / B5 / C1 等保持 📝 Proposed 状态，待后续讨论。

## 1. 背景与现状

「标签」的当前实现集中在以下三处：

| 关注点 | 位置 | 行为 |
|--------|------|------|
| 顶部「预设标签」输入框 | [`board-preview-app.js`](../../src/components/board-preview-app.js) 中的 `_parsePredefinedTags`（约 88-97 行）、HTML 模板（约 285-300 行） | 用户输入逗号 / 中文逗号 / 空格分隔的字符串，解析为 `_predefinedTags: string[]`，去重保序后通过 `setPredefinedTags` 广播给每个 Cell |
| Cell 内下拉添加 / chip 列表 | [`board-preview-cell.js`](../../src/components/board-preview-cell.js) 中的 `_renderTagsAdder` / `_renderTagsChips` / `_addTag` / `_removeTag`（约 369-456 行） | 下拉框只有一组 `<optgroup label="预设">` + 一个 `自定义…`（弹 prompt）；chip 列表平铺所有已选标签，每个 chip 带 `×` 移除 |
| 按标签导出 CSV | [`board-preview-app.js`](../../src/components/board-preview-app.js) 中的 `exportCsvByTag`（约 1032-1059 行） | `window.prompt` 单关键字 + 子串匹配 |

**不支持**的现状：

- 没有任何「分组 / 分类」概念，所有标签是平铺关键字
- 没有视觉区分：相同 chip 样式无差别，不利于扫视
- 没有跨 Cell 的标签统计 / 整理入口
- 「按标签导出」表达力弱（已有独立提案：[多标签导出](./multi-tag-export.md)，此处不重复）
- 折叠态（[全局棋盘优先紧凑视图](../../styles/main.css)）下隐藏了 chips，用户无法一眼知道某个 Cell 已被标过多少条

## 2. 设计目标

围绕「**让标签从平铺关键字走向轻量结构**，并让用户在不展开 Cell 的情况下也能感知标签状态」展开：

1. 给用户一种「分类」表达手段，**零数据迁移成本**
2. chip 的视觉同步「类别」语义，扫视密集 Cell 区时一眼可分
3. 折叠态保留对标签状态的最小感知（已标多少条 / 哪些类别）
4. 顶部提供整盘的标签分布概览，便于「整理批注」流程

## 3. 提案项清单

每一项标注 **复杂度（小 / 中）** 与 **优先级建议（P0/P1/P2）**。P0 推荐先做，P1 联动有意义，P2 视未来需求。

---

### 3.1 分类（结构）

#### A1. 斜杠前缀的隐式分组（P0，小）

**约定**：标签字符串中首个 `/` 之前的部分视为「类别」、之后视为「值」。未带 `/` 的标签当作无分类，保留旧行为。

示例预设标签输入：

```
难度/简单, 难度/中等, 难度/困难, 阶段/草稿, 阶段/已审, 测试
```

**Cell 下拉框**渲染（替换 `_renderTagsAdder` 中目前唯一的 `optgroup label="预设"`）：

```html
<select>
  <option hidden>+ 添加</option>
  <optgroup label="难度">
    <option value="tag:难度/简单">简单</option>
    <option value="tag:难度/中等">中等</option>
    <option value="tag:难度/困难">困难</option>
  </optgroup>
  <optgroup label="阶段">
    <option value="tag:阶段/草稿">草稿</option>
    <option value="tag:阶段/已审">已审</option>
  </optgroup>
  <optgroup label="其它">
    <option value="tag:测试">测试</option>
  </optgroup>
</select>
```

**实现要点**：

- 新增纯函数 `groupTagsByPrefix(tags: string[]): Array<{ category: string | null, values: string[] }>`，建议放在 `src/components/tagGrouping.js`，便于单测复用
- `_renderTagsAdder` 改为消费分组结果
- chip 列表仍按用户添加顺序展示（不打散）；分组只影响下拉

**取舍**：

- ✅ 零迁移，旧标签无 `/` 仍然显示在「其它」组
- ✅ 不要求 UI 大改，只是 `<optgroup>` 的多一次拆分
- ❌ 一个标签里出现多个 `/` 时如何归类需明确：建议只取**首个** `/` 之前作为类别，避免引入嵌套树

#### A2. 「最近使用」组（P1，小）

在 Cell 下拉框「预设」组之上加一个 `<optgroup label="最近使用">`，列出最近 8 个被添加过的标签（去重 LRU），跨 Cell 共享，存 `localStorage`。

**实现要点**：

- `localStorage` key 约定：`bp:recent-tags:v1`，序列化 `string[]`，最长 8
- 在 `_addTag` 成功路径里推送（`board-preview-cell.js` 约 444 行），App 层用一个 helper 统一管 LRU
- App 层广播：跨 Cell 同步推荐列表，简单起见可只在 hydration 时刷新一次

**取舍**：

- ✅ 解决「同一标签反复手动找位置」的痛点
- ❌ 多标签项目偶尔反而被「最近 8 条」抢位置；建议显示在最上方但用 `disabled` 样式弱化（如灰底）

#### A3. 同组互斥规则（P2，中）

**约定写法**：预设标签里以 `!` 前缀标记互斥组成员，例如 `!难度/简单, !难度/中等, !难度/困难`；当选中其中一个时自动移除同前缀组内其它已选标签。

**实现要点**：

- 解析时把 `!` 剥离并记录 `mutexCategories: Set<string>`
- `_addTag(tag)` 命中互斥组时，先 `_removeTag` 同前缀的其它标签
- chip 渲染**不显示** `!` 前缀

**取舍**：

- ✅ 适合「单选难度 / 单选阶段」这类业务约束
- ❌ 引入额外语法学习成本；与 A1 强耦合
- ⚠️ 若同一标签先后被多个 Cell 引用、用户中途修改互斥规则，需要决定是否回写既有 Cell；建议保持「只影响新添加」，已存在的 chip 不动

---

### 3.2 展示（视觉 / 反馈）

#### B1. 标签稳定颜色哈希（P0，小） — 📌 Planned

对 tag 字符串做简单哈希 → HSL **色相**，chip 的背景、边框、文字按主色派生：

```js
function tagHue(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
```

**落点**：

- `_renderTagsChips`（[`board-preview-cell.js`](../../src/components/board-preview-cell.js) 约 381-410 行）给每个 chip 设 `style.setProperty('--chip-h', tagHue(tag))`
- [`styles/main.css`](../../styles/main.css) 中 `.bp-chip`（约 642 行）使用：

```css
.bp-chip {
  --chip-h: 145;
  background: hsl(var(--chip-h) 60% 28% / 0.35);
  border: 1px solid hsl(var(--chip-h) 60% 55% / 0.6);
}
.bp-chip__label { color: hsl(var(--chip-h) 65% 88%); }
```

**取舍**：

- ✅ 工作量极小，相同标签永远同色，不同标签自动错开
- ✅ 与方案 A1 正交：颜色由完整字符串决定，分组只影响布局
- ⚠️ 色弱用户需要保证亮度 / 对比度有底线（饱和度 / 亮度固定，仅色相变化）

**复用范围（实施约定）**：

- `tagHue` 抽到独立模块（建议 `src/utils/tagColor.js`），供下列三处统一调用：
  1. Cell 内 chip（`_renderTagsChips`）
  2. 顶部使用计数 chip 行（B4）
  3. 「按标签导出」多选浮层中的标签选项（[multi-tag-export.md](./multi-tag-export.md)）
- 色相基础值统一加 30° 偏移以避开 UI 主色相（约 145° 绿）：`(rawHue + 30) % 360`

#### B2. chip 内分组前缀弱化样式（P1，小）

配合 A1：当 tag 含 `/`，chip 内拆为两段渲染：

```html
<span class="bp-chip">
  <span class="bp-chip__category">难度</span>
  <span class="bp-chip__sep">/</span>
  <span class="bp-chip__value">简单</span>
  <button class="bp-chip__remove">×</button>
</span>
```

CSS 让 `.bp-chip__category` 用 `var(--bp-muted)` 小字、`.bp-chip__value` 保持正色。

**取舍**：

- ✅ 节省 chip 横向空间，扫视时直接读到「值」
- ❌ 与 A1 联动；单独做没有意义

#### B3. 折叠态下「+ 添加」按钮旁的已选数小角标（P0，小）

折叠态（`.bp-app--cells-collapsed`）目前隐藏了 `.bp-cell__tags-chips`（见 [styles/main.css](../../styles/main.css)），导致看不出当前 Cell 是否已被标记过 / 标记了几条。

**落点**：

- 在 `_renderTagsAdder`（[`board-preview-cell.js`](../../src/components/board-preview-cell.js) 约 369 行）末尾紧跟 `<select>` 追加一个 `<span class="bp-cell__tags-count">3</span>`，数量来源是 `this._tags.length`
- `_tags.length === 0` 时不渲染该角标
- CSS 仅在 `.bp-app--cells-collapsed` 下显示该角标可减少展开态噪音；展开态用户已经能看到 chips

**取舍**：

- ✅ 修复折叠态的「信息盲点」
- ⚠️ 多 Cell 时角标也只显示自己 Cell 的计数；整盘统计请见 B4

#### B4. 顶部预设标签的「使用计数 chip 行」（P1，中） — 📌 Planned

在顶部 `.bp-app__tags`（[`board-preview-app.js`](../../src/components/board-preview-app.js) 约 285-300 行）的输入框下方追加一行只读的 chip 列表：

```
预设标签 [简单] [中等] [困难] [测试] [废弃] …
        (3)   (5)   (1)   (12)  (0)
```

每个 chip 旁加 `(n)`，表示该标签当前被几个 Cell 选中；`n=0` 的标签 chip 用低对比样式（提醒可清理）。

**实现要点**：

- 抽公共纯函数 `countTagUsage(entries, predefined): Record<tag, number>`（建议放 `src/io/tagFilter.js`，与「多标签导出」共用）
- 统计来源必须兼顾**未水合 entry**：`entry.cellEl?.readTags?.() ?? entry.item.tags ?? []`，否则 CSV 大批量导入但未滚动到的条目会被漏统计
- 事件入口：监听 `bp-cell-change`（Cell 内 `_afterTagsChanged` 已派发，见约 458-462 行）；以及 `setPredefinedTags` 后；以及 entry 增删时
- `requestAnimationFrame` 节流，避免一帧内多次广播触发抖动
- 复用 B1 的 `tagHue`，chip 样式与 Cell 内 chip 一致以建立视觉关联
- chip 文案格式：`tagName count`（实施时可采用空格分隔的两段 span 排版），`count === 0` 时整 chip 套 `.bp-app__tag-stat--empty` 用 `var(--bp-muted)` 弱化
- 本 chip 列表也是 C2 的入口（点击切换激活态）；展示与交互合二为一

**取舍**：

- ✅ 整盘标签分布的全局视角，导出 / 整理批注的关键支撑
- ✅ 与 B1 复用同一套配色与组件，可作为「标签设计语言」起点
- ❌ 大量 Cell + 大量预设标签时，统计可能成为热路径；可加 `requestAnimationFrame` 节流，或只在 `bp-cell-change` 事件触发时增量更新计数

#### B5. chip 键盘可达（P2，小）

当前 chip 整体不可聚焦；只有 `×` 按钮可点击。

**落点**：

- `_renderTagsChips`（[`board-preview-cell.js`](../../src/components/board-preview-cell.js) 约 391-405 行）给 `.bp-chip` 加 `tabindex=0`、`aria-keyshortcuts="Delete"`
- 监听 `keydown` 在 `Delete` / `Backspace` 时触发 `_removeTag`

**取舍**：

- ✅ 可访问性合规改进，零样式冲突
- ⚠️ 与 `×` 按钮的 click 顺序需小心避免 double-fire

---

### 3.3 跨 Cell（轻量批量）

#### C1. 「应用到全部 / 应用到筛选可见」按钮（P2，中）

在顶部预设标签 chip 行（B4）每个 chip 上右键 / 长按 / 弹小菜单，提供：

- **应用到所有 Cell**：把该标签批量加到所有 Cell（已包含则不重复）
- **应用到当前可见的 Cell**：与未来「标签筛选视图」（C2）配合

**落点**：

- App 层调用 `entries.forEach(e => e.cellEl?._addTag?.(tag))` —— 需要把 `_addTag` 暴露为公开 `addTag`（或新增公共方法）
- 派发 `bp-cell-change` 让 B4 计数刷新

**取舍**：

- ✅ 项目末期需要给整批 Cell 打「测试 / 已审」标签时极省时
- ⚠️ 误触代价高，应给一次确认 toast / 撤销机制（撤销已超出"不复杂"范畴，可暂留）

#### C2. 标签筛选视图（P1，中） — 📌 Planned

顶部 chip 行（B4）支持点击切换筛选态。激活集合为 `F`、cell 标签集为 `T`：

- **OR 模式**（默认）：`T ∩ F ≠ ∅` 则显示
- **AND 模式**：`F ⊆ T` 则显示
- `F = ∅` 时所有 cell 均显示（等价于无筛选）

UI 在 chip 行旁提供一个 `[OR ⇄ AND]` 切换按钮 + 「清空筛选」 + 命中数提示「显示 N / 共 M 条」。

**与导出的边界（实施决议）**：

- 「按标签导出 CSV」与「按标签导出 CSV…」**始终遍历全量 `_entries`**，**不**受 C2 筛选状态影响
- 即"筛选是查看视图的工具，导出是数据投递的工具"，两者解耦
- 导出弹层中如有"沿用当前筛选作为初始勾选"的便捷选项，由 [multi-tag-export.md](./multi-tag-export.md) 落实，但默认值不耦合

**落点**：

- App 层维护 `_activeTagFilter: { tags: Set<string>, mode: 'or' | 'and' }`，状态**仅内存**（刷新清空），不持久化
- 抽公共纯函数 `matchTagFilter(cellTags, { any?, all?, none? })`（与 [multi-tag-export.md §4.1](./multi-tag-export.md) 同名）：
  - OR 视为 `any = [...F]`
  - AND 视为 `all = [...F]`
- 计算结果应用到 `_entries[i].el.hidden`；隐藏的 entry 让 `IntersectionObserver` 自然不再触发水合，不需要额外卸载
- 状态行 `.bp-app__grid-info` 文案扩展为：`共 N · 已渲染 M · 显示 K`（仅当有筛选时显示第三段）

**边界 / 风险**：

- 跳转功能（`_jumpFromInput`）目标 entry 若被筛选隐藏：先发 toast 提示「目标被筛选隐藏，已为你跳到首个命中条目」并跳到 `F` 命中的首条，避免静默失败
- 折叠 / 展开状态与本筛选完全独立
- 用户清空"预设标签"输入时，已激活筛选若含被删除标签 → 同步从 `_activeTagFilter` 移除并刷新

**取舍**：

- ✅ 标签的「查找」与「导出」清晰解耦，语义不绕
- ✅ 与 [多标签导出](./multi-tag-export.md) 共用 `matchTagFilter` 纯函数，零额外算法
- ⚠️ 视觉上需配合空状态提示「当前筛选下 0 条」与"清空筛选"按钮

---

### 3.4 约束（语义层）

#### D1. 禁用 Cell 内"自定义…"入口 + 顶部预设标签删除拦截（P0，小） — 📌 Planned

让"标签来源"成为唯一可信路径：

- **新增标签**：只能由 App 顶部「预设标签」输入框写入；Cell 内下拉只列出当前 `_predefinedTags`
- **删除标签**：从顶部预设标签集合移除某条时，若仍有 Cell 在使用它，拒绝删除并以 toast 警告；删除"无 Cell 使用"的标签照常生效

**实施要点**：

1. **去自定义入口**：
   - HTML 模板移除 `自定义…` option，见 [`board-preview-cell.js`](../../src/components/board-preview-cell.js) 中 `connectedCallback` 模板（约 173 行）
   - `_renderTagsAdder` 中相应 option 追加逻辑同步删除（约 374-377 行）
   - `_onTagAddSelected` 中删除 `value === '__custom__'` 分支（约 416-429 行）
2. **删除拦截**：
   - App 上引入"上一次 commit 成功的 `_predefinedTags` 快照"
   - `_syncTagsInputs`（[`board-preview-app.js`](../../src/components/board-preview-app.js) 约 434 行）入口先做差集判断：
     - `removed = previous \ next`
     - 对每个 `tag ∈ removed`，统计仍在使用的 entry 数 `n = countTagUsage(_entries, [tag])[tag]`（复用 B4 的 `countTagUsage`）
     - 若 `n > 0`：回滚输入框值（与广播都不发生），通过 `bp:toast` 派发错误「标签「tag」正在被 n 个预览框使用，无法删除」
     - 若 `n === 0`：照常广播并更新快照
3. **未水合 entry 也要算**：`entry.cellEl?.readTags?.() ?? entry.item.tags ?? []`，与 B4 同一套逻辑

**取舍 / 边界**：

- ✅ 防止"误删一行预设标签 → 所有 Cell 仍然带着这个标签 → 看不见但导出仍有"的隐蔽脏数据
- ✅ 简化标签输入语义，所有标签都从同一个池子来
- ⚠️ 用户从 JSON / CSV bundle 加载历史数据时，可能携带不在当前预设里的"野生标签"；此时**不应自动**把它们注入 `_predefinedTags`，而是：
  - 让 B4 统计行能列出它们（用 `--bp-warn` 弱化样式作为"野生标签"标记）
  - 提供「合并到预设」按钮一键追加（可选，非本期必做）
- ⚠️ 批量删除（用户一次清空输入框）：按"每条标签独立判断"逐条决定是否拦截，不要整体回滚到旧值，否则有冲突的一条会拖垮所有删除
- ⚠️ 拦截后输入框 UI 表现：保持显示用户输入的字符串（让他看到自己想删什么），仅"已生效的 `_predefinedTags`"回滚到包含被拦截条目的版本；下次再点击"删除"或修改其它仍照常工作

**风险**：

- 若 N（Cell 数）极大且用户频繁编辑预设标签输入框，差集 + 全量遍历可能造成卡顿。可以与 B4 共享同一份 `countTagUsage` 缓存，仅在 `bp-cell-change` 时失效

---

## 4. 实现优先级建议

> 本次确认实施的最小集与依赖关系：

```
D1 (独立) ─────────────────────────────────┐
                                           │
B1 (独立) ─────────────────────────────────┼─→ 4. multi-tag-export 浮层
                                           │      （见独立提案）
B4 ── countTagUsage 公共函数 ──┬─→ C2 筛选 │
                              └─→ D1 删除拦截
```

推荐落地顺序：

1. **D1 禁用自定义 + 删除拦截**（独立、收益高、需要先于 B4 / C2 落地，避免脏数据进入统计）
2. **B1 颜色哈希**（独立、视觉收益大、为后续 chip 出现的所有地方建立色系）
3. **B4 预设标签使用计数**（提供 `countTagUsage` 公共函数，是 C2 与 D1 拦截判断的共同基础）
4. **C2 筛选视图**（OR/AND 切换，复用 B4 的 chip 行）
5. **多标签导出浮层**（独立提案 [multi-tag-export.md](./multi-tag-export.md)；共用 `matchTagFilter` 纯函数）

未在本次实施的项（A1 / A2 / A3 / B2 / B3 / B5 / C1）保持 📝 Proposed 状态。

## 5. 风险与回退

- **B1 颜色冲突**：极端 tag 字符串哈希可能落在与 UI 主色相邻的色相区间。回退方案：将哈希结果在 `[h0, h1]` 区间内做加偏（如固定偏移 30°）避开主色相。
- **A1 误分类**：业务场景中可能出现"标签里就是带 `/`"（如 `aspect/ratio`）的特殊标签。建议给一个 escape：以 `\/` 表示字面斜杠不分组。
- **B4 性能**：标签数 × Cell 数过大时计数函数可能成为热路径；建议在 `bp-cell-change` 中做 `requestAnimationFrame` 节流；首次渲染时统一全量更新一次即可。
- **回退**：所有改动都纯前端、纯渲染层，不改 `levelStr` 编解码、不改 `operations` 序列、不改 CSV 导出列结构。**任意一项可独立回退**。

## 6. 决策记录

| 项 | 选项 | 决定 | 时间 |
|----|------|------|------|
| 是否启用斜杠分组（A1） | 是 / 否 | 暂缓 | 2026-05-18 |
| 颜色策略（B1） | 全自动哈希 / 用户可配 / 不做 | 全自动哈希 + 主色相偏移 30° | 2026-05-18 |
| 折叠态计数角标（B3） | 折叠态独占 / 始终显示 / 不做 | 暂缓（折叠态紧凑视图已展示 chip） | 2026-05-18 |
| 顶部统计 chip 行（B4） | 启用 / 暂缓 | **启用**，并兼任 C2 入口 | 2026-05-18 |
| 标签筛选（C2）默认语义 | OR / AND / 切换 | **提供 OR / AND 切换** | 2026-05-18 |
| 筛选是否影响导出 | 影响 / 全量 | **全量**（导出与筛选解耦） | 2026-05-18 |
| 禁用 Cell 内自定义入口（D1） | 启用 / 不启用 | **启用** | 2026-05-18 |
| 删除预设标签拦截（D1） | 拦截 / 不拦截 / 仅警告但继续删除 | **拦截**（被使用即拒绝） | 2026-05-18 |
| 与 [多标签导出](./multi-tag-export.md) 的联动 | 共用 `matchTagFilter` / 各自实现 | **共用** `matchTagFilter` 与 `countTagUsage` | 2026-05-18 |
| 按标签导出旧入口去留 | 替换 / 新增并保留 | **新增并保留**旧 prompt 入口作为单关键字快速通道 | 2026-05-18 |

实现后请把对应项标记为 ✅ Implemented，并在本表追加 commit / PR 链接。
