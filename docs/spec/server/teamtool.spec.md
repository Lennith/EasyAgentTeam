# TeamTool 规范（最后更新：2026-04-16）

## 正式工具名

- `task_create_assign`
- `task_report_in_progress`
- `task_report_done`
- `task_report_block`
- `discuss_request`
- `discuss_reply`
- `discuss_close`
- `route_targets_get`
- `lock_manage`

## 运行时别名规则

- 逻辑工具名以上面的正式工具名为准
- 如果运行时暴露 provider 前缀或 MCP 前缀，必须调用运行时真实暴露的名字
- Codex CLI 下的 TeamTool 别名固定为 `mcp__teamtool__<tool_name>`

Codex MCP 别名：

- `mcp__teamtool__task_create_assign`
- `mcp__teamtool__task_report_in_progress`
- `mcp__teamtool__task_report_done`
- `mcp__teamtool__task_report_block`
- `mcp__teamtool__discuss_request`
- `mcp__teamtool__discuss_reply`
- `mcp__teamtool__discuss_close`
- `mcp__teamtool__route_targets_get`
- `mcp__teamtool__lock_manage`

## 参数层语义

- `task_create_assign`
  - 用于创建任务并指定 owner
  - 常见字段：`task_id`、`title`、`to_role`、`parent_task_id`、`root_task_id`
  - 协作字段：`dependencies`、`write_set`、`acceptance`、`artifacts`
- `task_report_in_progress`
  - 用于非终态进度上报
  - 必须提供 `content`
  - `progress_file` 只作为可选产物路径，不替代正文
- `task_report_done`
  - 用于终态完成上报
  - 必须提供 `task_report` 或 `task_report_path`
- `task_report_block`
  - 用于终态阻塞上报
  - 必须提供 `block_reason`
- `discuss_request`
  - 用于发起围绕 task 或 thread 的讨论
- `discuss_reply`
  - 用于在既有讨论线程内回复
- `discuss_close`
  - 用于关闭讨论线程
- `route_targets_get`
  - 用于查询当前允许的路由目标
- `lock_manage`
  - 用于共享文件或目录锁
  - 操作包括 `acquire / renew / release / list`

## 逻辑错误契约

所有 TeamTool 业务失败统一返回：

- `error_code`
- `message`
- `next_action`
- `raw`

## Codex MCP 传输层包装

在 Codex MCP 下，逻辑结果会再包一层 MCP tool result：

- `content[0].text`
  - 保存成功文本或错误 JSON 文本
- `isError`
  - `false` 表示工具执行成功
  - `true` 表示工具执行失败
- `structuredContent`
  - 若 `content[0].text` 可解析为对象，则镜像同一份结构化对象
  - 失败时通常对应同一份 `error_code/message/next_action/raw`

## 当前硬规则

- 只能对自己 owner 或自己创建的任务调用 `task_report_*`
- `task_create_assign` 遇到 `TASK_EXISTS` 时不得直接原样重试
- TeamTool 失败后必须依据 `next_action` 恢复
- 若需要重新路由，先调用 `route_targets_get`

## 规范边界

- 本页是 TeamTool 的唯一文档规范源。
- 运行时导出的工具集合和 alias 仍以服务端 contract builder 为准，测试要求代码与本页保持一致。
