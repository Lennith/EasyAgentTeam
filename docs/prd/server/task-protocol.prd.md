# 任务协议 PRD（最后更新：2026-05-06）

## 状态

- 文档状态：`实装`

## 目标

任务协议定义 project / workflow 任务的创建、查询、讨论、进度上报、终态上报和依赖约束，是多 Agent 协作的核心公开语义。

## 当前有效能力

- 任务树查询与 detail 查询
- 统一 task-actions 写路径
- project 与 workflow task action 请求契约由 `agent_library` Zod schema 统一定义，route/service 先做 schema parse 再调用任务协议服务
- project 任务元数据补丁写路径
- 讨论请求、回复、关闭
- 进行中、完成、阻塞三类报告
- 依赖未满足时拒绝不合法终态推进
- task assign 路由独立于普通 message/discuss 路由；`TASK_CREATE` / `TASK_ASSIGN` 只按 `task_assign_route_table` 判断可指派 owner role
- `task_assign_route_table` 缺失或为空时保持兼容允许；配置后普通 agent 只能给显式允许的目标角色指派任务，自指派也必须显式配置自身角色
- 系统来源 `manager`、`dashboard`、`system`、`user` 保持任务指派特权

## 当前公开路径

- project：`/api/projects/:id/task-tree`、`/api/projects/:id/tasks/:task_id/detail`、`/api/projects/:id/task-actions`、`/api/projects/:id/tasks/:task_id`
- workflow：`/api/workflow-runs/:run_id/task-tree`、`/api/workflow-runs/:run_id/tasks/:task_id/detail`、`/api/workflow-runs/:run_id/task-actions`

## 兼容边界

- project 不保留旧 `agent-handoff`、`reports`、`tasks` 兼容接口
- workflow 不保留旧 `step-runtime`、`step-actions` 接口
