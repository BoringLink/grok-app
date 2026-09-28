/**
 * composer 输入框编辑器的分发器（ADR 0004）。
 *
 * 目前只有一条路径：上游内置编辑器。本模块把它的组件与命令式 API 原样转发出来，
 * 让消费方（薄岛、send/dictation 钩子、workbench）只依赖这一个入口；「可选
 * Markdown 编辑器（TipTap）」的开关与第二套实现的挂载加在这里。
 *
 * 这样上游那份 `ComposerEditor.tsx` 可以保持逐字节不变，供上游作者对照。
 */

export * from "@/components/ComposerEditor";
