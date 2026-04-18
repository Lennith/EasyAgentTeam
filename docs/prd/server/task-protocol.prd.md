# 任务协议 PRD（最后更新：2026-04-17）

## 状态

- 文档状态：`验证中`

## 目标

任务协议定义 project / workflow 任务的创建、查询、讨论、进度上报、终态上报和依赖约束，是多 Agent 协作的核心公开语义。

## 当前有效能力

- 任务树查询与 detail 查询
- 统一 task-actions 写路径
- project 任务元数据补丁写路径
- 讨论请求、回复、关闭
- 进行中、完成、阻塞三类报告
- 依赖未满足时拒绝不合法终态推进

## 当前公开路径

- project：`/api/projects/:id/task-tree`、`/api/projects/:id/tasks/:task_id/detail`、`/api/projects/:id/task-actions`、`/api/projects/:id/tasks/:task_id`
- workflow：`/api/workflow-runs/:run_id/task-tree`、`/api/workflow-runs/:run_id/tasks/:task_id/detail`、`/api/workflow-runs/:run_id/task-actions`

## 兼容边界

- project 不保留旧 `agent-handoff`、`reports`、`tasks` 兼容接口
- workflow 旧 `step-runtime`、`step-actions` 接口维持退役状态
