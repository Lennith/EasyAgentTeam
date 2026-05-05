# Runtime Settings 与 System API PRD（最后更新：2026-04-30）

## 状态

- 文档状态：`实装`

## 目标

System API 负责暴露运行时全局配置、模型目录、项目模板、基础 prompt 与健康检查，是 dashboard 与外部工具的系统级入口。

## 当前有效能力

- `GET/PATCH /api/settings`
- `GET /api/auth/status`
- `POST /api/auth/login`
- `GET /api/models`
- `GET /api/project-templates`
- `GET /api/prompts/base`
- `GET /healthz`

## 当前规则

- `/api/settings` 只接受 provider profile 作为运行时配置模型。
- `providers.codex`、`providers.minimax` 与 `providers.dpagent` 是唯一有效的 provider settings 边界。
- Codex CLI 命令写在 `providers.codex.cliCommand`。
- DPAgent CLI 命令写在 `providers.dpagent.cliCommand`。
- MiniMax API key、API base、默认 model、sessionDir、MCP servers、step/token/output/shell limits 写在 `providers.minimax`。
- 远程访问只提供单密码 gate：未设置密码时 `/api` 保持本地开发/E2E 的无认证行为；设置密码后除 `POST /api/auth/login`、`GET /api/auth/status` 与 `/healthz` 外，所有 `/api/**` 都必须携带 bearer token 或 `X-Auto-Dev-Auth-Token`。
- `/api/settings` 只返回 `security.remote_password_enabled`，不返回 password hash、salt 或明文密码；`PATCH /api/settings` 通过 `security.remote_password` 设置或清除远程登录密码。
- `/api/auth/login`、`/api/auth/status` 与 `/api/settings` patch payload 由 `agent_library` Zod schema 定义；远程访问只做单密码 gate，认证后工具能力与本地一致。
- 旧的 settings 顶层字段已经退役；`PATCH /api/settings` 收到这些字段时返回 `SETTINGS_FIELD_RETIRED`，不会映射或兼容写入。
- provider runtime 的模型解析优先级为：dispatch/session 显式模型、role 配置、provider profile 默认模型、provider hardcoded default。
- mixed E2E baseline 不允许为了模型选择 patch 全局 provider model；只有显式 credential/base override 或 clear 才允许修改 MiniMax 凭证类设置。
- 模型列表支持 fallback 与 project-aware 查询。
- 系统 prompt 通过单独入口暴露，不混入页面文档。
