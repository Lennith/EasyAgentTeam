# 编排器模块 PRD (Orchestrator)

## 1. 模块目标

### 模块状态

- `实装`

### 模块职责

Project Orchestrator 负责项目运行态的调度闭环，核心包括：

- 基于 role/session 选择可派发任务或消息并触发执行
- 维护会话状态（`idle/running/blocked/dismissed`）
- 执行自动派发预算（`auto_dispatch_enabled` + `auto_dispatch_remaining`）
- 处理 running 超时与 reminder 重试
- 输出可回放事件链（dispatch/timeout/reminder）

**源码路径**: `server/src/services/orchestrator-service.ts`

### 解决问题

- 避免 agent 对“可见但依赖未满足”的任务误上报推进态，污染时间线与阶段顺序判定
- 保证每轮 dispatch 都有明确的 focus task，并把 blocked/task 依赖状态直接暴露给 agent
- 在异常超时/重派发场景下保持编排可恢复、可观测、可复盘

---

## 2. 功能范围

### 包含能力

- 手工 dispatch / loop 自动 dispatch
- `force + task_id` 强制投递
- `dispatch-message` 指定消息投递
- running 超时收敛 + reminder 机制
- role 维度会话收敛与冲突恢复

### 不包含能力

- task payload 协议校验（由 `task-action-service` 负责）
- message payload 协议校验（由 `manager-message-service` 负责）

---

## 3. 对外行为

### 3.1 输入

- `POST /api/projects/:id/orchestrator/dispatch`
- `GET /api/projects/:id/orchestrator/settings`
- `PATCH /api/projects/:id/orchestrator/settings`

`dispatch` 请求关键参数：

- `role`（可选）
- `session_id`（可选）
- `task_id`（可选）
- `force`（可选）
- `only_idle`（可选）

约束：

- `role + session_id` 同时传入时必须一致，否则 `409 SESSION_ROLE_MISMATCH`

### 3.2 输出

- `results[]`（每个目标 session 的派发结果）
- 关键事件：
  - `ORCHESTRATOR_DISPATCH_STARTED`
  - `ORCHESTRATOR_DISPATCH_FINISHED`
  - `ORCHESTRATOR_DISPATCH_FAILED`
  - `SESSION_HEARTBEAT_TIMEOUT`
  - `ORCHESTRATOR_ROLE_REMINDER_TRIGGERED`
  - `ORCHESTRATOR_ROLE_REMINDER_RESET`

### 3.3 Dispatch Prompt 执行语义（状态：实装）

每次派发给 agent 的 prompt 必须明确以下上下文：

- `focus_task_id`
- `this_turn_operate_task_id`
- `visible_actionable_tasks`
- `visible_blocked_tasks`
- `focus_task_dependencies_ready`
- `focus_task_unresolved_dependencies`

执行约束（prompt contract）：

- 优先处理 focus task
- 非 focus task 在依赖已满足时允许上报，但属于次优行为
- 对依赖未满足任务，不得上报 `IN_PROGRESS/DONE/MAY_BE_DONE`
- 若因依赖门禁被拒绝，需等待依赖完成提示后再继续，并撤回或降级冲突性的提前完成结论

---

## 4. 内部逻辑

### 4.1 任务选择

1. 优先处理可执行任务派发消息
2. 讨论消息按线程规则插入调度
3. fallback 到 runnable task + message 组合
4. 无目标返回 `no_message`

### 4.2 Force Dispatch

- `force=true + task_id` 允许跨常规候选直接定位任务
- 允许状态：`READY | DISPATCHED | IN_PROGRESS | MAY_BE_DONE`
- owner role 无活跃会话时可自动 bootstrap session 并更新 owner 绑定

### 4.3 依赖门禁

- 常规派发必须通过依赖门禁（自身依赖 + 祖先链依赖）
- 依赖未满足任务不会作为有效推进目标进入派发候选

### 4.4 自动派发预算

- 仅“有效任务派发”扣减 `auto_dispatch_remaining`
- 预算归零触发 `ORCHESTRATOR_AUTO_LIMIT_REACHED`

### 4.5 超时与提醒

- running 超时后执行软收敛并补齐 run/dispatch 闭环事件
- reminder 基于 role 运行态 + open tasks 触发，不依赖旧 session 实例是否仍可用

---

## 5. 异常与边界

| 场景                              | 结果                          |
| --------------------------------- | ----------------------------- |
| session 正忙                      | `session_busy`                |
| task 不存在                       | `task_not_found`              |
| task 状态不允许 force             | `task_not_force_dispatchable` |
| task owner 与 session role 不一致 | `task_owner_mismatch`         |
| 命中未闭合重复派发                | `already_dispatched`          |
| runner 执行失败                   | `dispatch_failed`             |

---

## 6. 数据与事件

### DispatchOutcome

- `dispatched`
- `no_message`
- `task_not_found`
- `task_not_force_dispatchable`
- `task_owner_mismatch`
- `already_dispatched`
- `session_busy`
- `session_not_found`
- `dispatch_failed`

### 关键事件

- `ORCHESTRATOR_DISPATCH_STARTED`
- `ORCHESTRATOR_DISPATCH_FINISHED`
- `ORCHESTRATOR_DISPATCH_FAILED`
- `SESSION_HEARTBEAT_TIMEOUT`
- `ORCHESTRATOR_ROLE_REMINDER_TRIGGERED`
- `ORCHESTRATOR_ROLE_REMINDER_RESET`

---

## API Path Registry (docs:check)

Orchestrator settings endpoints (exact path contract):

- `GET /api/projects/:id/orchestrator/settings`
- `PATCH /api/projects/:id/orchestrator/settings`
