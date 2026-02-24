# 编排器模块 PRD (Orchestrator)

## 1. 模块目标

### 模块职责
编排器负责项目级调度闭环：

- 选择可派发任务/消息并触发执行
- 维护会话状态（`idle/running/blocked/dismissed`）
- 执行自动派发预算（`auto_dispatch_enabled` + `auto_dispatch_remaining`）
- 处理 running 超时与 idle reminder

**源码路径**: `server/src/services/orchestrator-service.ts`

### 关键设计约束

- 会话调度主键统一为 `sessionId`
- role 是业务视角，session 是执行组件
- `providerSessionId` 仅内部运行态信息

---

## 2. 功能范围

### 包含能力

- 手工/自动 dispatch
- `force + task_id` 强制投递
- `dispatch-message` 指定消息投递
- 超时收敛与 repair 配套
- role reminder

### 不包含能力

- task payload 校验（`task-action-service`）
- message payload 校验（`manager-message-service`）

---

## 3. 对外行为

### 3.1 输入

`POST /api/projects/:id/orchestrator/dispatch`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| role | string | 否 | 目标角色 |
| session_id | string | 否 | 目标 sessionId |
| task_id | string | 否 | 指定 task |
| force | boolean | 否 | 强制派发 |
| only_idle | boolean | 否 | 仅 idle |

补充规则：

- `role + session_id` 同时传入时必须一致，否则 `409 SESSION_ROLE_MISMATCH`

### 3.2 输出

- `results[]`（每个 session 的派发结果）
- 事件链：`ORCHESTRATOR_DISPATCH_*`、`SESSION_HEARTBEAT_TIMEOUT`、`ORCHESTRATOR_ROLE_REMINDER_*`

---

## 4. 内部逻辑

### 4.1 任务选择

1. 优先处理可执行的 `TASK_ASSIGNMENT`。
2. discuss 消息按规则插入调度。
3. fallback 到 runnable task + message 组合。
4. 无目标则 `no_message`。

### 4.2 force dispatch

- `force=true + task_id` 从全量任务定位。
- 允许状态：`READY | DISPATCHED | IN_PROGRESS | MAY_BE_DONE`。
- owner role 无活跃会话时，自动 bootstrap 会话并更新 ownerSession。

### 4.3 依赖门禁

- 常规派发必须通过依赖门禁（自身依赖 + 祖先链依赖）。

### 4.4 自动派发预算

- 仅“有效任务派发”扣减 `auto_dispatch_remaining`。
- 预算归零发 `ORCHESTRATOR_AUTO_LIMIT_REACHED`。

### 4.5 超时与提醒

- running 超时：终止进程、补齐 run/dispatch 收敛事件、会话转 `dismissed`。
- reminder 只基于 role runtime state + open tasks，不再依赖具体 session 切换。

---

## 5. 异常与边界

| 场景 | 结果 |
|---|---|
| session 忙 | `session_busy` |
| task 不存在 | `task_not_found` |
| task 状态不允许 force | `task_not_force_dispatchable` |
| task owner 与 session role 不一致 | `task_owner_mismatch` |
| runner 失败 | `dispatch_failed` |

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
