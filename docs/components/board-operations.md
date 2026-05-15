# Board 操作集

本页约定 **Tile3 叠层棋盘**（羊了个羊类）单个关卡在预览框内可执行的**几何变换**，对结构化数据（与 [编解码组件](codec.md) 中 `x` 行、`y` 列、`z` 层、`suit` 花色一致）的影响，以及写入导出包时 `operations` 数组的**记录格式**。

实现以 [`src/board/boardOperations.js`](../../src/board/boardOperations.js) 与 [`src/board/operationGlyphs.js`](../../src/board/operationGlyphs.js) 为准，本文档与代码**逐行对应**。

> 标签的增删改不属于本文「几何操作集」，仍可在同一 `operations` 流中以独立 `type` 记录，见文末 [标签（非几何）](#标签非几何)。

---

## 1. 数据模型与坐标约定

每块棋子是一条记录：

```ts
type Tile = { x: number; y: number; z: number; suit: string };
```

| 字段 | 含义 | 说明 |
|------|------|------|
| `x` | 行（向下递增） | 棋子**占格左上角**的行下标 |
| `y` | 列（向右递增） | 棋子**占格左上角**的列下标 |
| `z` | 层（俯视叠放） | `z` 越大越靠上层；同 `z` 同 `(x,y)` 区域可能与相邻棋子重叠 |
| `suit` | 花色字符 | 可为空字符串；与坐标按顺序一一对应 |

### 1.1 棋子在棋盘上的占格（2×2，必读）

- 每张牌**宽 2 格 × 高 2 格**，即占格为：

  ```
  (x,   y)  (x,   y+1)
  (x+1, y)  (x+1, y+1)
  ```

- 数据中**只存左上角锚点** `(x, y)`，其余三格由「锚点 + 固定偏移」推导，**不在解码后改变锚点含义**。
- 渲染层只需把 grid-item 设为 `grid-row: x..span 2 / grid-column: y..span 2`，详见 [渲染组件](render.md)。

### 1.2 排序约定

按 `(z, x, y)` 升序排列（先 `z`，同 `z` 比 `x`，同 `x` 比 `y`）；与 `format.py` 的 `RawPositionWithSuitData.sort` 一致。

**这是编码侧的硬性前提**：`PositionDataFormatter` 状态机依赖单调坐标，重复或乱序会抛错。任何几何变换 **完成后** 都要重排序，详见 [3.5](#35-后置排序zxy-升序)。

---

## 2. 操作类型一览

| `type` | 名称 | 几何含义 | 改变 `z`？ | Z 轴相关 |
|--------|------|----------|------------|----------|
| `rotate_left` | 左旋转 | XY 平面内**视觉上逆时针 90°** | 否 | 否 |
| `rotate_right` | 右旋转 | XY 平面内**视觉上顺时针 90°** | 否 | 否 |
| `mirror_x` | X 镜像 | 关于行方向（水平）中心线对称，"上下"翻 | 否 | 否 |
| `mirror_y` | Y 镜像 | 关于列方向（垂直）中心线对称，"左右"翻 | 否 | 否 |
| `flip_z` | Z 反转 | `z` 取关于层范围中心的对称，**叠放顺序整体反转** | **是** | **是** |

> 「视觉左/右转」按**屏幕坐标**命名：`x` 向下、`y` 向右；左转 = 视觉逆时针 90°，右转 = 视觉顺时针 90°。
> 实现 UI 时按钮文案可用"名称"列；**导出与回放必须使用稳定的 `type` 字符串**。

### 2.1 操作记录字符表（UI 紧凑显示）

`operations` 数组按顺序串联输出一行紧凑字符串，用于预览框内的"操作记录"行（实现见 `operationGlyphs.js`）：

| `type` | 字符 |
|--------|------|
| `rotate_left` | `L` |
| `rotate_right` | `R` |
| `mirror_x` | `X` |
| `mirror_y` | `Y` |
| `flip_z` | `Z` |

未知 `type` 输出 `?`，便于发现污染。`BOARD_OP_GLYPH_LEGEND` 常量提供人类可读图例：`L=左转 R=右转 X=X镜像 Y=Y镜像 Z=Z层反转`。

---

## 3. 单次变换流程（与代码逐行对应）

`applyBoardOperation(tiles, op)` 的核心步骤：

```text
1. clone tiles                       —— 不破坏原数组
2. b = getFootprintCellBounds(tiles) —— 计算"占格闭区间"包围盒
3. for tile of tiles:
     if op == flip_z:
       仅变换 tile.z
     else:
       对 2×2 的四角分别 transformGridPoint(...) 套 op 公式
       new_x = min(row of 4 corners)
       new_y = min(col of 4 corners)
       tile.x, tile.y = new_x, new_y
4. tiles.sort by (z, x, y) 升序
5. return tiles
```

下面逐项解释为什么这样写。

### 3.1 两类包围盒：`getBounds` vs `getFootprintCellBounds`

| 函数 | 含义 | 用途 |
|------|------|------|
| `getBounds(tiles)` | 仅看**锚点**的极值：`xmin = min(t.x)`、`xmax = max(t.x)`、`ymin/ymax` 同理 | **渲染**用，决定棋盘 grid 行列数（`rowCells = xmax - xmin + 2`，最后 `+2` 把 2×2 的尾巴留出来） |
| `getFootprintCellBounds(tiles)` | 看**整个 2×2 占格的并集**：`xmin = min(t.x, t.x+1)`、`xmax = max(t.x, t.x+1)` | **几何变换**用，作为旋转/镜像/翻转公式里的 `xmin/xmax/ymin/ymax/zmin/zmax` |

两者本质上是同一组关键点的不同视角；几何变换必须用**占格闭区间**，否则旋转/镜像 90°后无法把"右边那 1 格"也正确翻过去。

### 3.2 为什么对 2×2 的四个格点都变换、再取 min

只对锚点 `(x, y)` 套公式，结果是棋子**某一个角**的新位置；但旋转 90° 之后，原本的"左上"可能变成了"右上"或"左下"，新锚点必须仍是"占格中行/列最小的那个角"——这才是"重新规整为左上锚点"。

实现上：对 `(x,y), (x+1,y), (x,y+1), (x+1,y+1)` 四个点都套用同一公式，再取四个结果点的 `min(row)` 与 `min(col)`：

```js
let minR = Infinity, minC = Infinity;
for (const [r, c, z] of tileCornerCells(t)) {
  const p = transformGridPoint(r, c, z, op, b);
  minR = Math.min(minR, p.row);
  minC = Math.min(minC, p.col);
}
t.x = minR;
t.y = minC;
```

这样无论 op 是哪一种，新锚点都仍然是该牌 2×2 区域的"行最小、列最小角"——即左上角——保持锚点语义不变。

### 3.3 公式（以单点 `(x, y)` 书写）

| 操作 | 公式 |
|------|------|
| `rotate_left` | `x' = ymax - y + xmin,  y' = x - xmin + ymin,  z' = z` |
| `rotate_right` | `x' = y - ymin + xmin,  y' = xmax - x + ymin,  z' = z` |
| `mirror_x` | `x' = xmax + xmin - x,  y' = y,                z' = z` |
| `mirror_y` | `x' = x,                y' = ymax + ymin - y,  z' = z` |
| `flip_z` | `x' = x,                y' = y,                z' = zmax + zmin - z` |

> 公式中的 `xmin/xmax/ymin/ymax/zmin/zmax` 取自 **`getFootprintCellBounds`**（占格闭区间），而不是仅锚点的 `getBounds`。
> 当 `xmin = ymin = 0` 时，`rotate_left` 退化为 `x' = ymax - y, y' = x`；`rotate_right` 退化为 `x' = y, y' = ymax - x`。

### 3.4 `flip_z` 的特殊处理

`flip_z` **只动 `z`**，不动 `x, y`。代码里特判提前 `continue`，跳过"四角取 min"流程——因为对四角做 `flip_z` 得到的新四角 `(x, y, zmax+zmin-z)` 与原来 `(x, y)` 完全相同，min 也就是 `(x, y)` 本身，等价于直接改 `z`。

### 3.5 后置排序（`(z, x, y)` 升序）

每次变换都重排，是为了：

1. **满足 `toLevelStr` 的单调假设**：`PositionDataFormatter` 状态机要求按 `(z, x, y)` 单调递增遍历，否则会抛 `XXX重复: N` 之类的错。
2. **`suit` 跟随锚点同序**：tile 是 `{x, y, z, suit}` 一体的对象，sort 时 suit 自动随锚点搬动，编码时 `suit` 序列自然对齐 `(x, y, z)` 序列。

---

## 4. 数学性质（不变量与复合）

实现里这些性质都自然成立，记录下来便于回归测试时构造 fixtures：

- **整数性**：所有公式只做 `+/-`，整型输入 → 整型输出。
- **范围保持**：变换后所有锚点仍在 `[xmin..xmax-1] × [ymin..ymax-1] × [zmin..zmax]` 区间（旋转会让行/列范围互换大小，但仍是同一个矩形区域）。
- **复合性**：
  - `rotate_left ∘ rotate_left ∘ rotate_left ∘ rotate_left = id`
  - `rotate_right = rotate_left⁻¹`
  - `mirror_x ∘ mirror_x = id`，`mirror_y ∘ mirror_y = id`
  - `flip_z ∘ flip_z = id`
- **`flip_z` 与 XY 操作交换**：`flip_z` 不动 `x,y`，XY 操作不动 `z`，二者可任意交换顺序。
- **`rotate_left` 与 `mirror_x`/`mirror_y` 不交换**：旋转 → 镜像 ≠ 镜像 → 旋转，回放时必须严格按 `operations` 数组顺序应用。

---

## 5. 与编辑会话的集成

`BoardPreviewCell`（[`src/components/board-preview-cell.js`](../../src/components/board-preview-cell.js)）维护一组关于操作的状态字段，本节给出它们的语义。

### 5.1 状态字段

| 字段 | 类型 | 含义 |
|------|------|------|
| `_tiles` | `Tile[]` | 当前已解码的牌位列表 |
| `_sourceLevelStr` | `string` | **本编辑会话的原始关卡串**；CSV 导入时即为该行单元格，手动粘贴解码时为粘贴的串 |
| `_operations` | `Array<{ type, payload }>` | 自 `_sourceLevelStr` 起按顺序记录的几何操作 |
| `_hadZ` | `boolean` | 是否曾经施加过 Z 轴相关操作，**单调升**（见 5.3） |

### 5.2 用户点击工具栏按钮的流程

代码见 `applyOperation(op)`：

1. 若 `_tiles` 为空，提示"请先解码有效关卡"并返回。
2. `_tiles = applyBoardOperation(_tiles, op)`，新列表已 `(z,x,y)` 排序。
3. `_operations.push({ type: op, payload: {} })`——按用户点击逐条追加，不做合并。
4. 若 `isZAxisOperation(op)` 为真（当前只有 `flip_z`），`_hadZ = true`。
5. `levelTextarea.value = toLevelStr(_tiles)`——把新串写回输入框，便于用户复制或继续编辑。
6. 触发 `bp-cell-change` 事件，渲染棋盘。
7. 若 `toLevelStr` 抛错（如坐标重复），错误信息显示在卡片错误条，**操作记录仍已追加**——但 levelStr 没更新；这种情况在工程上不应发生（合法操作不会产生重复坐标），出现即视为 bug。

### 5.3 `_hadZ` 的单调性

只有在 `applyOperation` 中、且 `isZAxisOperation(op)` 为真时才置 `true`，**没有任何路径会把它再设回 false**——除了 5.4 的"回到原始关卡"。

这与导出元数据 `meta.hadZAxisOperation` 的语义对齐：**只要这条关卡的编辑过程中出现过 Z 轴反转，就标记为 true**，便于下游过滤"是否含 Z 轴操作"。

### 5.4 "回到原始关卡"（重置会话）

按钮 `data-action="reset-level"` 触发 `_resetToOriginalLevel()`：

1. 若 `_sourceLevelStr` 为空（用户从未点过"解码 / 应用"），显示提示，**什么都不做**。
2. 把 `_levelTextarea.value` 改回 `_sourceLevelStr`。
3. `_operations = []`，`_hadZ = false`——**唯一一处把 `_hadZ` 改回 false 的入口**。
4. 重新解码并渲染。

### 5.5 "解码 / 应用"按钮的会话语义

`applyDecode(resetSession)`：

- `resetSession = true`（用户主动点击）：以当前输入框内容为新的会话起点：
  - `_sourceLevelStr = 输入框内容`
  - `_operations = []`，`_hadZ = false`
- `resetSession = false`（CSV 导入水合时内部调用）：仅解码渲染，不清空 `operations` 与 `sourceLevelStr`，保持导入快照的会话历史。

### 5.6 回放语义（导出 ⇄ 重入）

任何一条导出的 `(sourceLevelStr, operations, levelStr)` 必须满足：

```
toLevelStr(
  operations.reduce(
    (tiles, op) => applyBoardOperation(tiles, op.type),
    fromLevelStr(sourceLevelStr)
  )
) === levelStr
```

这是导入侧 / 回归测试的契约。手动粘贴新串再点"解码 / 应用"会清空会话，新的 `sourceLevelStr` 等于粘贴值、`operations = []`，契约自然成立。

---

## 6. 导出形状

### 6.1 单条几何操作记录（JSON）

```json
{
  "type": "rotate_left",
  "payload": {}
}
```

- `payload` 对本操作集的五种类型为空对象，预留给未来扩展（如"相对某参考框"等参数化操作）；不要用 `type` 编码参数。
- 若未来追加非几何操作（如标签 `tag_add` / `tag_remove`），按独立 `type` 写入同一数组即可，回放器要按 `type` 分派。

### 6.2 CSV 导出附加列

按 [导入导出组件](io.md) 约定，CSV 导出会在原始列后追加四列：

| 列名 | 来源 | 说明 |
|------|------|------|
| `sourceLevel` | `_sourceLevelStr` | 该编辑会话的源关卡串 |
| `operator` | `operationsToGlyphString(_operations)` | 操作记录的紧凑字符串（如 `LXZ`） |
| `targetLevel` | `_levelTextarea.value` | 当前关卡串（即 `toLevelStr(_tiles)`） |
| `HasZOperator` | `_hadZ ? "1" : "0"` | 是否含 Z 轴操作（**只看 `_hadZ` 标志**，不重新扫 `operations`；用 `1`/`0` 而非 `TRUE`/`FALSE`，便于直接进数据管线） |

### 6.3 JSON 导出 `meta.hadZAxisOperation`

字段名独立，**与 `HasZOperator` 同源同步**，下游消费方择一即可。导出时取自 `_hadZ`。

---

## 7. 错误与边界

| 场景 | 行为 |
|------|------|
| 当前关卡为空（`_tiles.length === 0`）时点工具按钮 | 显示"请先解码有效关卡"，不修改任何状态 |
| `toLevelStr` 抛错（坐标重复等） | 错误显示在卡片错误条；状态机制要求合法输入永不重复，出现视为上游 bug |
| 未知 `op` 传给 `applyBoardOperation` | `transformGridPoint` 抛 `未知操作: {op}`，调用方应捕获并展示 |
| 未点过"解码 / 应用"就点"回到原始关卡" | 显示提示，不动状态 |
| CSV 导入条目尚未水合（骨架）时导出 | 用导入快照里的 `operations` / `sourceLevelStr` / `levelStr` / `hadZAxisOperation`，不重新计算 |

---

## 8. 与渲染的关系

- **数据变换路径**（本项目采用）：点击按钮直接改 `_tiles` 数组再编码，与本页公式一一对应；导出回放天然一致。
- **视图变换路径**（不采用）：仅用 CSS `transform` 表现旋转/镜像，导出前必须把等价变换烘焙到坐标，否则 `operations` 与 `levelStr` 会不一致。

详见 [渲染与预览组件](render.md)。

---

## 标签（非几何）

标签的增删改若需进入同一 `operations` 流，建议使用独立类型：

- `tag_add` / `tag_remove` / `tag_set`：`payload` 带 `label: string` 或 `labels: string[]`。

此类操作 **不** 设置 `hadZAxisOperation`，回放器应按 `type` 分派、跳过几何变换路径。

当前实现把标签状态独立维护在 `_tags` 字段、导出时单独写入 `tags` 列，**不进入 `operations` 数组**；如果未来需要"标签编辑历史"，再扩展到 `operations` 流，本节作为扩展契约预留。
