# 提案：Board Offset（柱子级视觉偏移）

> **状态**：✅ Confirmed — 决策已定（见 §11），实施中
> **范围**：编解码组件（新增 `src/codec/offsetCodec.js`）· 渲染组件 · 导入导出组件 · `BoardPreviewCell` 操作集
> **关联**：[编解码组件](../components/codec.md) · [Board 操作集](../components/board-operations.md) · `src/codec/charMap.js`

## 0. TL;DR

- 引入并行于 `level_str` 的 **`offset_str`**：零或多个 **4 字符组** 的拼接 `z + row + col + marker`，长度必须是 4 的倍数。
- 前 3 位用项目现有 `charMap` 的 62 进制（`0-9A-Za-z`）；第 4 位 `marker` 用**独立**的 48 进制字符表 `A-Xa-x`，分别编码 **8 个方向 × 6 个档位**。
- 解码后是一组 `OffsetRecord { z, row, col, direction, magnitude }`，本质是**该柱子私有的 Z 偏移向量**——同 `(row, col)` 上的每一层都按 `(t.z - offRec.z) × dirVec × 单层增量` 累计偏移（与全局 Z 偏移同质，仅作用范围限于该柱）。
- 几何变换（旋转 / 镜像 / Z 反转）下，方向需重映射，档位不变；具体规则等 [Board 操作集 §9](../components/board-operations.md) 写就后对齐，**本期不实现**。
- 错误一律 `throw new Error(...)`，与 `levelCodec.js` / `positionFormatter.js` 一致；不引入 `OffsetError` 之类的自定义类。

---

## 1. 背景与需求

当前 Cell 只把关卡渲染为"层叠的 2×2 棋子"，所有视觉错位由全局 [Z 偏移](../README.md) 提供——每层加同一个 `(--bp-zoffset-x, --bp-zoffset-y)`，整盘均匀飘。

但真实关卡里，**柱子之间会被设计师手工往不同方向"挪一点"**（视觉幅度，不影响判牌），用以制造遮挡 / 引导视觉焦点。这部分信息在上游编辑器里序列化为一段 **`offset_str`**，紧挨着 `level_str` 一同存盘。

本提案在不改动现有 `level_str` 编解码 / 几何操作集前提下，**新增并行的 offset 解码 → 数据模型 → 渲染叠加 → 编码导出**整条管线。

## 2. 数据模型与命名映射

### 2.1 一条 offset 记录

```ts
type OffsetRecord = {
  /**
   * 柱子的"基准层"层号，0–61，与 Tile.z 同语义；
   * 推荐取该柱子的最底层（min(z) of tower），渲染时以此为零点累计层差：
   *   tile_offset = (t.z - offRec.z) × dirVec × 单层增量
   */
  z: number;
  /** 锚点行下标，向下为正，0–61，与 Tile.row 同语义 */
  row: number;
  /** 锚点列下标，向右为正，0–61，与 Tile.col 同语义 */
  col: number;
  /** 方向编号 0–7（见 §4.3） */
  direction: number;
  /** 档位编号 0–5；第 (magnitude+1) 档，**单层**增量 = (magnitude+1) × 单位量（§4.4） */
  magnitude: number;
};
```

### 2.2 与上游命名空间的映射

| 本项目 | 上游 / 你给的规则 | Vita 历史命名 | `format.py` |
| :---: | :---: | :---: | :---: |
| `row`（行，向下） | `row` | `y` | `x` |
| `col`（列，向右） | `col` | `x` | `y` |
| `z`（层） | `z` | `z` | `z` |

> 本项目编解码模型已统一为 `row / col`（与你给的规则同名）。Vita 与 `format.py` 的对照见 [编解码组件](../components/codec.md)。

## 3. 字符串结构

```text
offset_str = group*
group      = char[z] char[row] char[col] marker_char
```

| 位 | 字段 | 字符表 | 数值范围 |
| :---: | --- | --- | :---: |
| 1 | `z` | [`charMap.js`](../../src/codec/charMap.js) — `0-9A-Za-z` | 0–61 |
| 2 | `row` | 同上 | 0–61 |
| 3 | `col` | 同上 | 0–61 |
| 4 | `marker` | **独立字符表** `A-Xa-x`（24 + 24 = 48） | 0–47 |

> **字符表分离很关键**：`marker` 只用大写 `A-X` + 小写 `a-x`，**不**复用 `charMap` 的 62 进制。混用会让 `Y`、`Z`、`y`、`z` 被误识别为方向/档位编码。两套表互不复用，编解码模块各自常量化。

空串 `""` 合法，等价于"无 offset"。长度不是 4 的倍数即非法。

## 4. Marker 编码

### 4.1 字符 ↔ 数字

| 字符段 | 数值 |
| :---: | :---: |
| `A` – `X` | 0 – 23 |
| `a` – `x` | 24 – 47 |

### 4.2 数字 → (方向, 档位)

```js
direction = Math.floor(n / 6);  // 0..7
magnitude = n % 6;              // 0..5
```

### 4.3 方向枚举

约定 `(dRow, dCol)`：`dRow` 向下为正（行号增加方向），`dCol` 向右为正（列号增加方向），与 §2 命名一致。

| 数值 | 方向 | `(dRow, dCol)` |
| :---: | :---: | :---: |
| 0 | 上 | `(-1,  0)` |
| 1 | 下 | `(+1,  0)` |
| 2 | 左 | `( 0, -1)` |
| 3 | 右 | `( 0, +1)` |
| 4 | 左上 | `(-1, -1)` |
| 5 | 右上 | `(-1, +1)` |
| 6 | 左下 | `(+1, -1)` |
| 7 | 右下 | `(+1, +1)` |

### 4.4 档位语义

档位描述的是**"每升一层"的偏移增量**——offset 与全局 Z 偏移在视觉机制上同质（都是"逐层累加 translate"），只是 offset 的方向/档位由每根柱子独立指定，仅作用于该 `(row, col)`。

- 第 `(magnitude + 1)` 档，**单层增量** `STEP = (magnitude + 1) × UNIT`（相对棋子宽度）。
- **初版** `UNIT = 1/100`（棋子宽度的百分比单位）；第 1 档 = 1% / 层，第 6 档 = 6% / 层。比全局 Z 偏移粒度更细，专为设计师做"逐层微错位"用。
- 柱子内第 `k` 层（`k = t.z - offRec.z`，以 `offRec.z` 为零点）总偏移 = `k × STEP × dirVec`。
- 示例：`offRec.z = 0`、`magnitude = 5`（6%/层）、`direction = 0`（上）——
  - 0 层（k=0）：原位
  - 1 层（k=1）：相对 0 层向上 6% 棋子宽度
  - 2 层（k=2）：相对 0 层向上 12% 棋子宽度
- 档位是**视觉幅度**信息，几何变换（旋转 / 镜像）**不改变档位**。

## 5. 解码（`offset_str` → `OffsetRecord[]`）

JS 参考实现（落点：`src/codec/offsetCodec.js`）：

```js
import { charToNumber } from './charMap.js';

const MARKER_RE = /^[A-Xa-x]$/;

export function markerToNumber(ch) {
  if (!MARKER_RE.test(ch)) {
    throw new Error(`非法 marker 字符: "${ch}"（合法范围 A-X / a-x）`);
  }
  const code = ch.charCodeAt(0);
  if (ch >= 'A' && ch <= 'X') return code - 'A'.charCodeAt(0);
  return code - 'a'.charCodeAt(0) + 24;
}

export function parseOffsetStr(offsetStr) {
  if (offsetStr == null || offsetStr === '') return [];
  if (offsetStr.length % 4 !== 0) {
    throw new Error(`offset 长度不是 4 的倍数: ${JSON.stringify(offsetStr)}`);
  }
  const out = [];
  for (let i = 0; i < offsetStr.length; i += 4) {
    const group = offsetStr.slice(i, i + 4);
    let z, row, col;
    try {
      z = charToNumber(group[0]);
      row = charToNumber(group[1]);
      col = charToNumber(group[2]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`offset 第 ${i / 4 + 1} 组「${group}」: ${msg}`);
    }
    const n = markerToNumber(group[3]);
    out.push({ z, row, col, direction: Math.floor(n / 6), magnitude: n % 6 });
  }
  return out;
}
```

> **错误带组号**：所有"非法字符"错误都附 `第 K 组「XXXX」` 前缀，配合 cell 的 `_setError` UI 直接定位。

## 6. 编码（`OffsetRecord[]` → `offset_str`）

```js
import { numberToChar } from './charMap.js';

export function numberToMarker(n) {
  if (!Number.isInteger(n) || n < 0 || n > 47) {
    throw new Error(`marker 数值越界: ${n}（合法 0–47）`);
  }
  if (n < 24) return String.fromCharCode('A'.charCodeAt(0) + n);
  return String.fromCharCode('a'.charCodeAt(0) + n - 24);
}

export function serializeOffsetRecords(records) {
  if (!Array.isArray(records) || records.length === 0) return '';
  const parts = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const dir = r.direction, mag = r.magnitude;
    if (!Number.isInteger(dir) || dir < 0 || dir > 7) {
      throw new Error(`第 ${i + 1} 条 direction 越界: ${dir}`);
    }
    if (!Number.isInteger(mag) || mag < 0 || mag > 5) {
      throw new Error(`第 ${i + 1} 条 magnitude 越界: ${mag}`);
    }
    parts.push(
      numberToChar(r.z) + numberToChar(r.row) + numberToChar(r.col)
        + numberToMarker(dir * 6 + mag),
    );
  }
  return parts.join('');
}
```

## 7. 一致性约束

| 约束 | 说明 | 处理 |
| --- | --- | --- |
| 长度 | `len(offset_str) % 4 === 0`，0 长度即"无 offset" | `parseOffsetStr` 抛错 |
| 位置必须命中 Tile | `(row, col)` 必须是某块 Tile 的左上角锚点 | 解码后的**校验阶段**严格抛错（见 §10.2） |
| 位置唯一 | 同一 `(z, row, col)` 在一个 offset 字符串里最多出现一次 | 校验阶段抛 `offset 位置重复: (z, row, col)` |
| 字符越界 | `z/row/col` ∉ `[0, 61]` 或 marker ∉ `[A-Xa-x]` | 立即抛错；禁止静默截断或回退 |
| `z` 与柱子最底层关系 | **推荐** `z = min(z of tiles at (row, col))`；本层暂**不强校验** | 仅 toast warn |

> 第 2、3、5 条不在编解码模块里跑，而是在"应用到 board"那一步（§10）跑——保持 codec 模块的**纯文本可逆性**，便于单元测试。

## 8. 错误处理与边界

与 `levelCodec.js` 风格一致：所有异常用 `throw new Error("offset ...: ...")`，统一中文前缀；UI 层（`BoardPreviewCell._setError` + toast）负责把 Error 文案展示给用户。

| 场景 | 期望行为 |
| --- | --- |
| `offset_str` 为空 / `null` / `undefined` | 返回 `[]`，不抛 |
| 长度非 4 倍数 | `Error("offset 长度不是 4 的倍数: ...")` |
| `z/row/col` 字符越界 | `Error("offset 第 K 组「XXXX」: 非法字符: \"?\"")` |
| marker 字符越界 | `Error("非法 marker 字符: \"?\"（合法范围 A-X / a-x）")` |
| 位置未命中 Tile（校验阶段） | `Error("offset 位置不在 board 内: (z, row, col)")` |
| 同位置重复（校验阶段） | `Error("offset 位置重复: (z, row, col)")` |
| `direction / magnitude` 越界（序列化前） | `Error("第 K 条 direction/magnitude 越界: ...")` |

## 9. 不变量与回归测试

新增 `test/offsetCodec.test.js`（沿用 `node:test` + `node:assert/strict`，参考 `test/csv.test.js`）：

1. **解析 ∘ 序列化 = id**：`serializeOffsetRecords(parseOffsetStr(s)) === s` 对所有合法 `s`。
2. **序列化 ∘ 解析 = id**：`parseOffsetStr(serializeOffsetRecords(rs))` 与 `rs` 在字段上深等。
3. **字段顺序固定**：交换 4 字符组里任意两位，解码出的记录与原记录除偶发数值巧合外不应相等。
4. **marker 双向一致**：对所有 48 个合法字符 `c`，`numberToMarker(markerToNumber(c)) === c`；对所有 `n ∈ [0, 47]`，`markerToNumber(numberToMarker(n)) === n`。
5. **样本回归**：固化样本 `"082N086T042N046T000N008T"` 为 fixture，断言每组解码后的 `(z, row, col, direction, magnitude)`，以及 `serialize ∘ parse === id`。
6. **错误用例**：长度非 4 倍数、字符越界、marker 越界 各至少一条断言抛错。

## 10. 与现有组件的契约

### 10.1 编解码组件（`src/codec/`）

- 新增 `offsetCodec.js`：导出 `parseOffsetStr` / `serializeOffsetRecords` / `markerToNumber` / `numberToMarker` 4 个纯函数，**不依赖** DOM、不依赖 `Tile[]`。
- 不修改 `charMap.js`、`levelCodec.js`、`positionFormatter.js` 的现有签名。

### 10.2 位置校验（应用到 board）

把"位置必须命中 Tile" / "位置唯一" / "z 推荐为柱子底层"放在一个新文件，**单独**于 codec：

```js
// src/board/offsetApply.js
export function applyOffsetsToTiles(tiles, records) { /* 严格抛错 */ }
```

返回一个 `Map<TileKey, OffsetRecord>`，key 形如 `${row},${col}`——因为是柱子级。

### 10.3 Board 操作集 — 几何变换下的 offset（已实现）

实现位置：[`src/board/offsetOperations.js`](../../src/board/offsetOperations.js)；由 `BoardPreviewCell.applyOperation` 在 tile 变换前算出 `getFootprintCellBounds(_tiles)` 并把同一份 bounds 同时喂给 `applyBoardOperation` 与 `applyBoardOperationToOffsets`，保证两侧锚点严格对齐。详细推导见模块 JSDoc。

| 操作 | `(row, col)` | `direction` | `magnitude` | `z` |
| --- | --- | --- | :---: | --- |
| `rotate_left` | 同 tile 锚点变换（4 角取 min） | `(dr, dc) → (-dc, dr)` | 不变 | 不变 |
| `rotate_right` | 同 tile 锚点变换 | `(dr, dc) → ( dc,-dr)` | 不变 | 不变 |
| `mirror_x` | 同 tile 锚点变换 | `(dr, dc) → (-dr, dc)` | 不变 | 不变 |
| `mirror_y` | 同 tile 锚点变换 | `(dr, dc) → ( dr,-dc)` | 不变 | 不变 |
| `flip_z` | 不变 | **反向**（视觉等价） | 不变 | `zMin + zMax - z` |

> **`flip_z` 反向 + 翻 z 的推导**：渲染公式 `(t.z - offRec.z) × dirVec × step` 在 `t.z' = zMin+zMax-t.z` 下视觉不变，要求 `(dir', offRec'.z) = (-dir, zMin+zMax-offRec.z)`。这与 §7 的"`offRec.z` 推荐 `min(z of tower)`"的软约束兼容——flip_z 后 `offRec.z` 不再等于柱子局部 min(z)，但渲染结果完全正确。
>
> `flip_z` 也会让 `hadZAxisOperation` 置位（已有约定）。
>
> 回归测试见 [`test/offsetOperations.test.js`](../../test/offsetOperations.test.js)：覆盖恒等不变量、可逆、旋转方向公式、`flip_z` 视觉等价性、不可交换性、真实样本的解析→变换→序列化全链路。

### 10.4 渲染组件

- 现有 [Z 偏移](../components/render.md) 是**全局每层 ×**一个常量；offset 是**柱子私有的 Z 偏移向量**——同一根 `(row, col)` 上每升一层都按 `(t.z - offRec.z) × dirVec × STEP` 累加，作用范围限于该柱。两者**叠加**：单格最终偏移 = `globalZOffset(z) + perTowerOffset(row, col, z)`。
- 实现：渲染层逐 tile 计算 `(t.z - offRec.z) × (mag + 1) × UNIT × dirVec`，写入 `style.setProperty('--bp-tile-offset-x', ...)` / `--bp-tile-offset-y`，**单位是棋子宽度的百分比**（与 `--bp-zoffset-x/y` 一致）。
- 同柱子（同 `(row, col)`）共用一条 `OffsetRecord`，但**每层根据自身 z 与 `offRec.z` 的差**算出各自的偏移量；柱子的基准层（`offRec.z` 处）偏移为 0。

### 10.5 导入导出（CSV）

| 通道 | 当前 | 提议 |
| --- | --- | --- |
| CSV | 有 `Content`、`Tags` 等列 | **新增 `Offset` 列**，与 `Tags` 同策略 —— **可选列**（identifier 列名 `Offset`，不区分大小写）；空值代表无 offset |
| 导入面板 | "关卡串所在列 / 标签所在列" | 追加"**Offset 所在列**"下拉，默认匹配 `Offset` 列；找不到则"无" |
| 导出元数据 | 含 `sourceLevel` / `operator` / `targetLevel` / `HasZOperator` | **永远输出** `sourceOffset` / `targetOffset` 两列（与 `sourceLevel / targetLevel` 同语义对齐；候选 A） |
| Cell 内部状态 | 仅 `levelStr` / `sourceLevelStr` | 平行加 `offsetStr` / `sourceOffsetStr`，与 levelStr 走同一份"原始关卡 / 当前关卡"流转 |

### 10.6 UI（`BoardPreviewCell`）

最小可用闭环（**本期**，不含可视化编辑器）：

- 在 level 串 textarea 下方加一个 **`offset 串` textarea**（默认显示，标 "可选"）。
- 复制 / 粘贴 / 解码 / 重置 4 个按钮同 level 串规则；粘贴时若 `_sourceOffsetStr` 已记录，发 warn toast 提示"解码后将覆盖原始 offset"。
- 渲染只读：在棋盘渲染上叠加偏移；空 offset 串时退化为现有行为。

可视化编辑（点击柱子选方向 / 调档位）**下期实现**。

---

## 11. 决策记录

按 §11 待决问题清单逐条对账：

| # | 问题 | 决定 |
| :---: | --- | --- |
| 1 | 命名映射 | **整个项目编解码模型统一为 `row / col`**（含 `Tile`、`levelCodec`、`positionFormatter`、`boardOperations` 等）；操作 `type` 字符串 `mirror_x / mirror_y` 保留历史命名以兼容存档 |
| 2 | `offset_str` 在 CSV 的存放 | **独立列 `Offset`**，与 `Tags` 同策略：可选、按列名识别 |
| 3 | 几何变换是否本期实现 | **分两期**：本期只做编解码 + 渲染叠加 + CSV 列导入导出；几何变换下期 |
| 4 | 档位单位量 | **`UNIT = 1/100`**（棋子宽度的百分比单位） |
| 5 | 导出元数据是否带 `sourceOffset / targetOffset` | **永远输出**两列（候选 A），与 `sourceLevel / targetLevel` 对齐 |
| 6 | 位置校验严格抛错 vs 降级 | **严格抛错**，与 `levelCodec.js` 一致 |
| 7 | 可视化编辑器是否本期做 | **下期**做；本期仅文本编辑 |
