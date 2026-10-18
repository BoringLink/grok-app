# ADR 0006 — 会话视口由应用显式控制，关闭引擎锚定

- 状态：已采纳
- 日期：2026-10-18

## 背景

会话流在持续输出期间会出现「向上闪烁漂移、丢失底部追踪」。第一轮修复把问题定位到跟随器的判据，但真正决定可行方案的是**引擎能力的三端差异**：

- 滚动锚定（`overflow-anchor`）的支持情况：Chromium（Windows WebView2）自 56 起、Edge 自 79 起、Firefox 自 66 起支持；**Safari 在 3.1–26.6 全部不支持，27 起才支持**（caniuse，2026-10-18 拉取）。WebKit 直到 2026-02 才把它开进 stable：bug 307734「[Scroll anchoring] Enable in stable」，2026-02-12 报告、RESOLVED FIXED、commit 307475@main（2026-02-13），并把长期存在的 bug 171099「Implement scroll anchoring」标为重复项。
- 本项目三端都出包（`src-tauri/tauri.{macos,windows,linux}.conf.json`，release workflow 三平台矩阵）：macOS 是 WKWebView、Windows 是 WebView2(Chromium)、Linux 是 WebKitGTK。macOS 构建产物的 `LSMinimumSystemVersion` 为 10.13，**今天所有 macOS 用户的 WKWebView 都没有引擎锚定**；而将来 macOS 随 Safari 27 升级后又会突然有。
- 即便在有锚定的 Chromium 上，它与本项目的写入也是互斥的：规范规定**滚动位置被脚本改变即令锚点失效**（CSS Scroll Anchoring Level 1 编辑草案 §2.1.1），并把锚点到滚动容器路径上任一元素的 `padding`/`height`/`margin`/`transform`/`position` 计算值变化列为**抑制触发器**（§2.2.2）。会话流恰好持续在做这两件事（跟随写入、spacer 与 padding 更新），所以开着锚定时引擎只会「有时补偿、有时不补偿」——这正是 `lobe-chat.part1.css` 里那句 “browser anchoring fights programmatic scrollTop during stream growth and feels like bounce” 记录到的现象，且无法靠调参消除。

## 决策

**会话流的位置由应用显式控制；引擎锚定被明确关闭。**

- 会话流滚动容器及其内部每一个嵌套滚动器（阶段步骤表、思考体、工具输出）都保持 `overflow-anchor: none`。规范 §3 注明：`overflow-anchor: none` 元素的**后代滚动容器会自动重新启用**锚定，除非它自己也设了该属性——所以这条规则必须逐个嵌套滚动器落实，不能只写在最外层。
- 只依赖三端引擎共同保证的行为：MutationObserver 回调是微任务（在渲染步骤之前）、ResizeObserver 通知的交付时机、`scroll` 事件语义、spacer 布局。
- `content-visibility`、`scrollend`、引擎锚定都不作为承重能力；将来使用只能作为渐进增强，且不得改变上述不变量。

## 影响

- **行为确定**：三端同一条代码路径、同一套验收。操作系统升级带来引擎锚定时，本项目的行为也不会悄悄变化。
- **代价是我们必须自己补偿**，且必须与布局变化同批次完成、在绘制之前——所以补偿由变更批次内的微任务驱动，而不是等 ResizeObserver 再等一帧。
- `overflow-anchor: none` 从「顺手关掉的浏览器特性」变成**承重配置**：它是让三端与各代引擎行为一致的开关，注释与文档都要按这个理由写，不允许被后来者当成无用样式删掉。
- 虚拟列表不再允许写 `scrollTop`（它是第二个写入者，会令锚点在引擎侧反复失效，也让不变量无法被单点维护）；它只产出布局。
- 若某天要改用引擎锚定，需要同时推翻本 ADR 与位置模型（单一写入者 + 锚点不变式），并接受 macOS 用户在 Safari 27 之前无法获得正确行为。

## 备选方案

- **交给引擎锚定**：macOS 与 Linux（WebKit）今天没有该能力，无法作为地基；即便将来有，脚本写入使其失效与抑制触发器的存在也让补偿时机不可预测。
- **按平台分支**（Windows 交给 Chromium、WebKit 用应用补偿）：三份行为路径、三份验收，且仍需判断「何时不该让引擎介入」，复杂度换来的是不一致。
- **底端原点滚动器（`flex-direction: column-reverse`）**：实测钉底只需一次写入且天然免疫遮挡，但阅读者在流式期间持续被推动（每帧 24px，实测），且 `scrollTop` 在该模式下为 0/负值语义、Safari 会把回弹写进 `scrollTop`。不满足 C3。
