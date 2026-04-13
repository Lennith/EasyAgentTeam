# Settings Module PRD

## 状态

- `实装`

## 目标

Settings 模块负责管理 Dashboard 的全局运行时配置，并作为后端 `/api/settings` 的唯一前端编辑入口。

当前有效范围：

- Dashboard 主题切换
- Codex CLI 命令配置
- MiniMax API / model / session / MCP / token / shell 参数配置
- 项目级 orchestrator 设置跳转与基础联动

本轮明确不包含：

- Trae CLI 配置
- provider 三选一 UI
- 与 TeamTool 无关的额外 Codex 工具配置

## 当前有效数据契约

`GET /api/settings` 与 `PATCH /api/settings` 暴露以下字段：

- `codexCliCommand`
- `theme`
- `minimaxApiKey`
- `minimaxApiBase`
- `minimaxModel`
- `minimaxSessionDir`
- `minimaxMcpServers`
- `minimaxMaxSteps`
- `minimaxTokenLimit`
- `minimaxMaxOutputTokens`
- `hostPlatform`
- `hostPlatformLabel`
- `supportedShellTypes`
- `defaultShellType`
- `codexCliCommandDefault`
- `macosUntested`
- `updatedAt`

约束：

- 不再暴露已下线 provider 的 CLI command 字段
- 不再暴露已下线 provider 的默认 CLI command 字段
- Dashboard 默认 provider 仍是 `minimax`

## UI 行为

- 页面加载时读取 `/api/settings` 并回填表单
- 保存时仅提交当前有效字段
- 主题切换需要立即作用到 `document.documentElement`
- Codex 配置仅显示单一 CLI 命令输入框，不显示 provider 选择器
- MiniMax 设置继续作为默认基线配置展示

## 兼容与迁移

- 后端读取旧 `runtime.json` 时，如果发现遗留已下线 provider 字段，前端不展示也不写回
- 前端不再生成任何已下线 provider 相关请求字段
- 老版本浏览器缓存不影响 API 读写契约，以服务端响应字段为准
