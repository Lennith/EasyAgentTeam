# Settings 页面 PRD（最后更新：2026-04-16）

## 状态

- 文档状态：`实装`

## 目标

Settings 页面负责编辑系统级运行时设置，并提供前端本地显示模式切换。

## 当前有效能力

- 切换主题并持久化当前主题
- 编辑 Codex CLI 命令
- 编辑 MiniMax API、模型、session 目录、最大步数和 token limit
- 查看主机平台与 shell 能力
- 切换 `Live API / Mock Data` 本地模式

## 非目标

- 不暴露已下线 provider 的设置项
- 不编辑自动探测出来的只读主机信息
- 不承担项目、团队或 workflow 级运行设置
