# ADR 0006 — MCP 厂商标识由宿主从注册域解析并缓存

- 状态：已采纳
- 日期：2026-10-30

## 背景

设置 → 扩展 → MCP 的每一行都用同一个插头图标，用户无法一眼区分 Context7、Linear、
GitHub 这类不同的 MCP 服务器。MCP Target 里已经有远程服务器的 URL，因此厂商站点本身
就是最合适的图标来源。

实测（2026-10-30）：

- `https://mcp.context7.com/favicon.ico` → 404；`https://context7.com/favicon.ico` → 200，74×75 PNG。
  说明必须从主机名剥到**注册域**，直接取 MCP 子域会落空。
- Google S2 / DuckDuckGo 图标服务都能返回同一张图，但都是第三方，会把用户配置了哪些
  MCP 厂商暴露给它们，且离线不可用。

## 决策

**厂商标识由宿主解析，来源限定为厂商自己的站点，并落盘缓存。**

1. 从 MCP Target 提取主机名，用 Public Suffix List 求**注册域**；只访问该注册域（必要时加
   原始主机）的 `https` 地址。
2. 先读站点根文档里的 `<link rel="icon">` / `<link rel="apple-touch-icon">` 候选，按尺寸优先；
   取不到再试 `/favicon.ico`。
3. 下载走既有的安全 HTTPS 客户端（DNS 校验 + 防 SSRF），限制体积与超时；解码后统一转成
   64×64 PNG（SVG 原样保留），以 data URL 交给前端渲染。
4. 结果按注册域缓存在 App 数据目录，正常结果 30 天、失败结果 7 天；过期后重新解析，失败时
   继续使用旧缓存。
5. 拿不到图标时回落到**字母徽标**，不请求任何第三方图标服务。

## 考虑过的选项

- **前端直接拼 Google S2 图标 URL**：代码最少，但把厂商域名发给 Google，离线不可用，质量
  不可控；与仓库「不向非必要第三方发送用户信息」的约束冲突。
- **随包内置品牌图标表**：视觉最稳、完全离线，但只覆盖已知厂商，新增厂商要发版；可作为
  后续增强，不解决长尾。
- **读取 MCP 规范的 `serverInfo.icons`**：语义最正确（MCP 2025-11-25 定义），但需要连上
  服务器完成 `initialize`，很多服务器尚未实现，且受鉴权限制；留作后续增强。

## 影响

- 新增一个宿主命令与缓存目录；设置页首次打开某个厂商时会多一次（缓存未命中时两次）网络请求。
- 远程 MCP 服务器才有图标来源；本地 `stdio` 服务器与取不到站点图标的厂商显示字母徽标。
- 图标是厂商站点的快照，厂商换标后最多滞后 30 天。

## 来源

- MCP 规范（`serverInfo.icons`、2025-11-25）：<https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle>
- 注册域解析：`psl` crate 2.1.245（Mozilla Public Suffix List）<https://docs.rs/psl/2.1.245/psl/>
- 实测响应：`mcp.context7.com/favicon.ico` 404，`context7.com/favicon.ico` 200 PNG（2026-10-30）
- 既有安全下载与页面解析：`src-tauri/src/skin_net.rs`、`src-tauri/src/wallpaper_web_page.rs`
