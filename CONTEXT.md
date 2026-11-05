# Grok App

Grok Build CLI 的桌面客户端外壳。这里只记录产品与领域语言，不记录实现细节。

## 领域语言

**MCP 服务器（MCP Server）**：
通过 Model Context Protocol 向 agent 提供工具、资源或提示词的服务，在设置 → 扩展 → MCP 中列出并启停。
_Avoid_：MCP 插件、MCP 工具

**MCP Target**：
MCP 服务器的连接目标。远程服务器是 URL（可能带路径和查询参数），本地服务器是启动命令。
_Avoid_：MCP 地址、MCP 端点

**厂商标识（Vendor Icon）**：
设置 → 扩展中代表 MCP 服务器所属厂商的方形图标，来源是该厂商自己的站点。
_Avoid_：favicon、logo、头像

**注册域（Registrable Domain）**：
从 MCP Target 的主机名剥到可注册的域名（例如 `mcp.context7.com` → `context7.com`），用于定位厂商站点。
_Avoid_：主域名、根域名

**字母徽标（Monogram）**：
拿不到厂商标识时，用服务器名首字母加固定配色生成的替身图标。
_Avoid_：占位图、默认图标
