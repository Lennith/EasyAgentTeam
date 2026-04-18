# Dashboard 共享 API 消费规范（最后更新：2026-04-16）

## 目标

本页只描述前端共享的 API 消费边界，不重复记录各页面的完整接口清单。

## 共享约束

- 前端默认通过统一的 API 访问层请求后端。
- API 访问层负责把后端字段映射成前端统一结构。
- 前端页面消费已经归一化后的 provider、session、event、timeline 数据，不重复定义迁移和兼容逻辑。

## 共享页面能力

- 首页：读取 project orchestrator 状态
- 项目工作区：详见 `project-workspace.api-spec.md`
- workflow 页面：详见 `workflow-ui.api-spec.md`
- settings 页面：详见 `settings-ui.api-spec.md`
- 调试观察页面：详见 `debug-observation.api-spec.md`
- hash 路由和本地状态：详见 `routing-and-local-state.api-spec.md`

## 明确边界

- 页面级接口清单放到对应页面 spec，不在本页重复展开。
- 业务状态流转放到 logic 文档，不在本页解释。
- 后端公开接口的完整语义以 server 侧 spec 为准。
