# 编排器模块 PRD (Orchestrator)

## 1. 模块目标

### 模块职责
编排器模块负责项目级自动调度与会话执行闭环，核心职责包括：

- 选择可派发任务/消息并触发执行
- 维护会话状态（`idle/running/blocked/dismissed`）
- 执行自动派发预算（`auto_dispatch_enabled` + `auto_dispatch_remaining`）
- 超时与提醒机制（running 超时收敛、idle 角色提醒）

**源码路径**: `server/src/services/orchestrator-service.ts`

### 解决问题

- 多角色并行场景下的任务分发顺序与去重
- 会话卡死、空转、重复派发等稳定性问题
- 自动派发预算可控、可观察

### 业务价值

- 保证任务驱动流程可持续推进
- 降低手工 dispatch 频率
- 提供事件可回放的调度审计链

---

## 2. 功能范围

### 包含能力

- 项目级 dispatch（手动/自动）
- 指定 task 的 force dispatch
- 消息派发（`dispatch-message`）
- 会话超时收敛与 repair 配套
- 角色 reminder（基于 open task + idle 时长）

### 不包含能力

- Task 写入校验细节（由 `task-action-service` 负责）
- 消息协议校验细节（由 `manager-message-service` 负责）
- 具体模型调用实现（由 `codex-runner` / `minimax-runner` 负责）

---

## 3. 对外行为

### 3.1 输入

#### 来源

- API：`POST /api/projects/:id/orchestrator/dispatch`
- API：`POST /api/projects/:id/orchestrator/dispatch-message`
- 内部：定时 `tickLoop`

#### 关键参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| session_id | string | 否 | 指定目标 session |
| task_id | string | 否 | 指定目标 task |
| message_id | string | 否 | 指定目标消息 |
| force | boolean | 否 | 允许强制派发 |
| only_idle | boolean | 否 | 仅对 idle 会话派发 |

### 3.2 输出

- `results[]`（每个 session 的派发结果）
- 调度事件链（`ORCHESTRATOR_DISPATCH_*`）
- 会话状态变化事件（超时、repair、提醒）

---

## 4. 内部逻辑

### 核心处理规则

#### 4.1 任务选择优先级（`selectTaskForDispatch`）

1. 优先处理与 runnable task 绑定的 `TASK_ASSIGNMENT`。
2. 可选处理 discuss 消息（task 已启动才可跟进）。
3. fallback 到 runnable task + message 组合。
4. 无可执行目标则返回 `no_message`。

#### 4.2 force dispatch 规则

- `force=true + task_id` 时允许从全量任务定位目标。
- 仅允许状态：`READY | DISPATCHED | IN_PROGRESS | MAY_BE_DONE`。
- 若 owner 无可用会话，自动 bootstrap session 后再派发。

#### 4.3 依赖门禁

- 普通派发要求 task 依赖门禁通过。
- 门禁会检查任务自身依赖及祖先链依赖满足情况。

#### 4.4 自动派发预算

- 预算字段：`auto_dispatch_remaining`。
- 仅“有效成功任务派发”会扣减预算。
- 扣减归零后发 `ORCHESTRATOR_AUTO_LIMIT_REACHED`。

#### 4.5 超时与提醒

- running 超时触发 `SESSION_HEARTBEAT_TIMEOUT` 并收敛状态。
- idle 角色基于 open task 触发 reminder，并可触发 redispatch。
- reminder 消息体包含 `open_task_ids` 与 `open_task_titles`（前若干条标题预览）。

---

## 5. 依赖关系

### 上游依赖

- `taskboard-store`：任务读取与 runnable 状态
- `session-store`：会话读写
- `inbox-store`：消息读取/确认
- `project-store`：项目配置（预算、路由、模型）

### 下游影响

- `codex-runner` / `minimax-runner`
- 事件流与时间线服务

---

## 6. 约束条件

### 技术约束

- 单会话并发受控，避免重复 dispatch。
- 调度参数受环境变量控制（interval/timeout/max concurrent）。

### 性能要求

- 在默认 tick 间隔内完成项目扫描与派发决策。
- 大量事件写入时仍保持可恢复与可观测。

---

## 7. 异常与边界

### 异常处理

| 场景 | 处理 |
|---|---|
| session busy | 返回 `session_busy` |
| task 不可派发 | 返回 `task_not_found` 或 `task_not_force_dispatchable` |
| runner 失败 | 记 `ORCHESTRATOR_DISPATCH_FAILED` |
| running 超时 | 标记超时并结束本轮 |

### 边界情况

- 指定 task 已终态：不再派发。
- 指定 message 不存在或已确认：返回未命中。
- force + 无 owner 会话：自动建会话后执行。

---

## 8. 数据定义

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
- `ORCHESTRATOR_DISPATCH_SKIPPED`
- `ORCHESTRATOR_ROLE_REMINDER_TRIGGERED`
- `SESSION_HEARTBEAT_TIMEOUT`

---

## 9. 待确认问题

- 是否需要将 reminder 策略参数项目化（当前主要是环境级配置）。
- force dispatch 的批次上限是否要单独配置。
