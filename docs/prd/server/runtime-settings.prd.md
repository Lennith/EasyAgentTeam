# Runtime Settings 与 System API PRD（最后更新：2026-04-25）

## 状态

- 文档状态：`验证中`

## 目标

System API 负责暴露运行时全局配置、模型目录、项目模板、基础 prompt 与健康检查，是 dashboard 与外部工具的系统级入口。

## 当前有效能力

- `GET/PATCH /api/settings`
- `GET /api/models`
- `GET /api/project-templates`
- `GET /api/prompts/base`
- `GET /healthz`

## 当前规则

- settings 只接受正式 provider 的合法字段。
- `/api/settings` 以 provider registry/profile 作为当前有效模型：`providers.codex` 与 `providers.minimax` 是内部运行时配置源。
- 旧字段 `codexCliCommand`、`minimaxApiKey`、`minimaxApiBase`、`minimaxModel`、`minimaxSessionDir`、`minimaxMcpServers`、`minimaxMaxSteps`、`minimaxTokenLimit`、`minimaxMaxOutputTokens` 继续作为兼容读写字段。
- provider runtime 的模型解析优先级为：dispatch/session 显式模型与 role 配置、provider profile 默认模型、provider hardcoded default。
- mixed E2E baseline 不允许为了模型选择 patch 全局 `minimaxModel`；只有显式 credential/base override 或 clear 才允许修改 MiniMax 凭证类设置。
- 模型列表支持 fallback 与 project-aware 查询。
- 系统 prompt 通过单独入口暴露，不混入页面文档。
