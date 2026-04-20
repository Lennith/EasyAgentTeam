# Workflow 工作区 PRD（最后更新：2026-04-19）

## 状态

- 文档状态：`实装`

## 目标

Workflow 工作区负责展示模板、run、会话、任务树运行态和工作区证据，是 workflow 模式的主要前端工作面。

## 当前有效能力

- 浏览与编辑 workflow template
- 创建 workflow run 与运行参数
- 查看 task tree runtime、timeline、sessions、workspace 证据
- Workflow 工作区提供 scoped Recovery 视图，用于查看当前 run 内待恢复 session、最近失败、cooldown、dismiss/repair/retry-dispatch 动作与最近恢复审计片段
- Recovery 视图的按钮能力完全以后端返回的 `can_* / requires_confirmation / disabled_reason / risk` 为准，前端只负责展示与确认，不自行推断动作是否允许
- dismissed session 的 manual recovery 与后续 retry-dispatch 都必须遵守后端确认与审计规则
- 发送 workflow agent chat 与 interrupt
- 观察 orchestrator settings 与 dispatch 结果

## 非目标

- 不在前端做 workflow 运行态计算
- 不在前端重建任务树算法
