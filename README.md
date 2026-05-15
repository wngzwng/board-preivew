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

技术栈：HTML、CSS、Js， 不需要第三方库，封装组件可使用 webcomponent技术
