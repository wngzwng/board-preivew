Board 预览（Tile3 / 羊了个羊式叠层关卡）
棋子贴图等资源见 src/assets/ 目录，渲染自取
支持文件的导入与导出
前端网格布局（页面排版，如 CSS Grid）
每个预览框支持
1. 左右旋转
2. x,y 镜像
3. Z轴反转
4. 标签标记（有默认的标记，外部可输入自定义的标签）

导出时，可支持按标签导出和全部导出

如果有操作，会记录操作，后续导出时，会记录操作以及新的board字符串
源board，操作，新board，是否有Z轴操作

1. 需要的组件
1.1 解码和编码方法（逻辑可参考 format.py）
2. 文件的导出和导入组件
3. 渲染关卡组件

## 本地运行与测试

- **页面**：在项目根目录启动静态服务（ES 模块需 HTTP，勿用 `file://` 直接打开 `index.html`），例如：  
  `python3 -m http.server 8080`  
  浏览器访问 `http://localhost:8080/`（根目录需能访问到 `index.html`、`src/`（含 `src/assets/`）、`styles/`）。
- **单测**：`npm test`（Node 自带 `--test`，校验编解码往返与几何操作）。
- **CSV 导入**：选择文件后自动解析并在下拉框列出列名（首行表头时取自表头；默认选中 **Content** 列），点「确认导入」写入预览框。
- **CSV 导出**：保留导入时的原始列，并追加 4 列：`sourceLevel`、`operator`（如 `LXZ`）、`targetLevel`、`HasZOperator`。

## 打包：合成单文件 `index.html`

把 HTML / CSS / 所有 ES Module 源码 / `src/assets/` 下的图片资源全部内联到一个独立的 `index.html`，方便部署或离线分发。

```bash
npm run build                              # 默认输出 dist/index.html
node scripts/bundle.js                     # 等价命令
node scripts/bundle.js --out=foo.html      # 自定义输出路径（相对项目根）
```

要点：

- 打包器 [`scripts/bundle.js`](scripts/bundle.js) **零运行时依赖**，仅使用 Node 自带的 `fs/path/url`；遵循"不引入第三方库"的项目宪法。
- 从 `src/main.js` 入口构建 ESM 依赖图并拓扑排序，把每个模块包成 IIFE 写入共享 `__M` 缓存，模拟 ES Module 语义。
- `src/assets/` 下所有已知后缀（png/jpg/jpeg/gif/webp/svg）的资源会被读为 base64 并注入到 `globalThis.__BP_ASSETS`；`src/assets/tileSources.js` 的查表 fallback 会把运行时拼出的相对路径自动替换为 `data:...`。开发期 `__BP_ASSETS` 不存在，行为不变。
- 输出体积、模块清单与资源清单会在终端打印，便于观察 bundle 构成。
- 产物默认在 `dist/`（已加入 `.gitignore`）。直接用浏览器打开生成的 HTML 即可（部分浏览器对 `file://` 协议有限制时仍建议挂到任意静态服务）。

打包器支持的 ESM 形态对应本项目当前用法：相对路径 `import`、副作用 `import`、命名 `import { a, b }`（含多行）、`export const/let/var/function/function*/class`。遇到未支持的写法（`export default`、`import * as ns`、`export {}` 等）会显式抛错而非静默丢失，便于扩展时及时发现。

技术栈：HTML、CSS、Js， 不需要第三方库，封装组件可使用 webcomponent技术
