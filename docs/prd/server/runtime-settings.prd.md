# Runtime Settings 与 System API PRD（最后更新：2026-04-16）

## 状态

- 文档状态：`实装`

## 目标

System API 负责暴露运行时全局配置、模型目录、项目模板、基础 prompt 与健康检查，是 dashboard 与外部工具的系统级入口。

## 当前有效能力

- `GET/PATCH /api/settings`
- `GET /api/models`
- `GET /api/project-templates`
- `GET /api/prompts/base`
- `GET /healthz`

## 当前规则

- settings 只接受正式 provider 的合法字段
- 模型列表支持 fallback 与 project-aware 查询
- 系统 prompt 通过单独入口暴露，不混入页面文档
