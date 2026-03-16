# Workflow Runtime 模块 PRD

## 1. 模块目标

### 模块状态

- `实装`

### 模块职责

Workflow Runtime 负责 workflow run 的运行态管理与编排闭环，覆盖：

- run 生命周期管理（`create/start/stop/status`）
- task runtime 状态机与依赖门禁
- 自动/手动调度（含预算、hold、并发保护）
- 会话超时处理与 reminder 机制
- 运行态查询与可观测事件输出

### 解决问题

- 避免 agent 对“可见但依赖未满足”的 phase/task 误上报 `IN_PROGRESS/DONE`，导致运行态时间线被污染
- 确保 workflow 每轮 dispatch 具备明确 focus task 语义，减少“看见任务就提前上报”的歧义
- 在 report 入口前置依赖门禁，防止依赖未满足状态通过后置回收才纠偏

### 主要源码

- `server/src/services/workflow-orchestrator-service.ts`
- `server/src/data/workflow-store.ts`
- `server/src/data/workflow-run-store.ts`
- `server/src/domain/models.ts`
- `server/src/app.ts`

---

## 2. 关键模型

### 2.1 Run 状态

`WorkflowRunState`:

- `created`
- `running`
- `stopped`
- `finished`
- `failed`

说明：

- `GET /api/workflow-runs/:run_id` 会对 `stopped + runtime 全终态` 做派生展示为 `finished`。

### 2.2 Task 状态与上报结果

`WorkflowTaskState`（与 taskboard 状态域对齐）:

- `PLANNED`
- `READY`
- `DISPATCHED`
- `IN_PROGRESS`
- `BLOCKED_DEP`
- `MAY_BE_DONE`
- `DONE`
- `CANCELED`

`WorkflowTaskOutcome`:

- `IN_PROGRESS`
- `BLOCKED_DEP`
- `MAY_BE_DONE`
- `DONE`
- `CANCELED`

### 2.3 Runtime 快照

`WorkflowRunRuntimeSnapshot`:

- `runId`
- `status`
- `active`
- `updatedAt`
- `counters`（`total/planned/ready/dispatched/inProgress/mayBeDone/blocked/done/canceled`）
- `tasks[]`（含 `state/blockedBy/blockedReasons/transitions/lastSummary`）

### 2.4 阻塞原因

`WorkflowBlockReasonCode`:

- `DEP_UNSATISFIED`
- `RUN_NOT_RUNNING`
- `INVALID_TRANSITION`
- `TASK_NOT_FOUND`
- `TASK_ALREADY_TERMINAL`

---

## 3. 编排器运行规则

### 3.1 Tick 范围

- 仅处理 `run.status == running` 的 run。
- 每个 tick 顺序执行：
  1. 载入 runtime/session
  2. 处理 running session 超时
  3. 自动结束窗口判定
  4. hold 判定
  5. reminder 与 MAY_BE_DONE 检查
  6. auto dispatch

### 3.2 依赖与父任务聚合

- 依赖未满足的 task 进入 `BLOCKED_DEP`。
- 依赖满足后可进入 `READY`。
- 父任务状态由子任务聚合：
  - 子任务全 `DONE/CANCELED` => 父任务 `DONE`
  - 依赖不满足 => 父任务 `BLOCKED_DEP`
  - 其他情况 => 父任务 `IN_PROGRESS`
- 依赖未满足任务不会因误上报形成有效推进态；推进态上报在 report 入口即被拦截。

### 3.3 自动结束策略（稳定窗口）

- 手工 `stop`：立即结束 run（状态 `stopped`）。
- 自动结束：满足以下条件并连续 2 个 tick 后置为 `finished`：
  - 所有 session 均不在 `running`
  - 不存在未完成 task
- 未完成 task 定义：状态不属于 `DONE/CANCELED`（即 `BLOCKED_DEP` 也算未完成）。
- 若中途条件不满足，稳定窗口计数清零。

### 3.4 调度规则

- 调度入口：loop 自动调度 + 手工 dispatch。
- 关键约束：
  - `run.status != running` 时，dispatch 返回 `run_not_running`。
  - loop 模式下，`hold_enabled=true` 时不执行任务调度。
  - auto dispatch 预算由 `auto_dispatch_enabled + auto_dispatch_remaining` 控制。
  - session 单飞保护与最大并发数限制同时生效。

### 3.5 Reminder 与超时恢复

- Reminder 基于 role 空闲状态和 open task 触发，支持 `backoff/fixed_interval`。
- running session 超时后触发软恢复；超过阈值可升级为 dismiss。
- 超时路径会补齐 dispatch/run 闭环事件，保持事件链可回放。

### 3.6 Dispatch Prompt 执行语义（状态：实装）

workflow dispatch prompt 必须明确：

- 当前轮 `focus task`
- 当前轮应优先操作任务
- 同角色可见可执行任务
- 同角色可见 blocked 任务
- focus task 依赖状态（已满足/未满足依赖列表）

执行约束：

- 优先处理 focus task
- 非 focus task 若依赖已满足且角色权限合法，可作为次优任务上报
- 对依赖未满足任务，禁止上报 `IN_PROGRESS/DONE/MAY_BE_DONE`
- 若收到依赖门禁拒绝，需等待依赖完成信号/提醒后再继续，并撤回或降级冲突性提前结论

---

## 4. Task Actions 协议

### 4.1 入口

- `POST /api/workflow-runs/:run_id/task-actions`

支持 `action_type`:

- `TASK_CREATE`
- `TASK_DISCUSS_REQUEST`
- `TASK_DISCUSS_REPLY`
- `TASK_DISCUSS_CLOSED`
- `TASK_REPORT`

### 4.2 TASK_REPORT 规则（状态：实装）

- `results[]` 必填。
- 仅接受 outcome：`IN_PROGRESS|BLOCKED_DEP|MAY_BE_DONE|DONE|CANCELED`。
- 非 `manager` 上报时，`from_agent` 必须与 task `ownerRole` 一致。
- 常规错误支持 partial apply，返回：
  - `appliedTaskIds`
  - `rejectedResults[]`
  - `partialApplied`
- `TASK_REPORT` 仅在 `run=running` 受理；否则返回 `RUN_NOT_RUNNING`。
- 依赖门禁是硬约束：
  - 当任一 result 试图把依赖未满足任务上报为推进态（`IN_PROGRESS|MAY_BE_DONE|DONE`）时，整次请求直接 `409` 拒绝（不进入 partial apply）。
  - 同批次 `results[]` 按输入顺序模拟状态演进，前序可应用结果会先影响后序 result 的依赖判定。
  - 因此，同批次内“依赖任务先 `DONE/CANCELED`、下游任务后推进”的顺序上报允许在单次请求内通过。
  - 错误码：`TASK_DEPENDENCY_NOT_READY`
  - 必须返回：
    - `task_id`
    - `dependency_task_ids`
    - 当前状态与目标状态
    - 等待依赖完成 + 撤回/降级冲突内容的 hint
- 依赖未满足任务上报 `BLOCKED_DEP` 允许。

### 4.3 Runtime 更新

- 每次 action 应用后都会重算依赖门禁与父任务状态。
- `TASK_REPORT` 成功后写入 `TASK_REPORT_APPLIED` 事件并更新 runtime 快照。
- 依赖未满足推进上报在 report 入口拒绝，不依赖后置状态回收纠偏。

### 4.4 TASK_CREATE 角色保护（状态：实装）

- `TASK_CREATE` 的 `task.owner_role` 必须属于“当前 run 角色集合”。
- 当 `owner_role` 不存在于当前 run 角色集合时，`POST /api/workflow-runs/:run_id/task-actions` 直接拒绝并返回：
  - `status=409`
  - `error_code=TASK_OWNER_ROLE_NOT_FOUND`
  - `message` 明确包含无效角色名
  - `hint/next_action` 指向 `route_targets_get` 纠正后重试
  - `details.available_roles` 返回当前可用角色摘要

### 4.5 Current Run 角色集合口径（状态：实装）

- 统一角色解析由 run 内信息决定，不混入全局 agent registry。
- 角色推导来源：
  - `routeTable` 与 `taskAssignRouteTable` 中出现的角色
  - 当前 run 的 sessions 中角色
- 兜底策略：
  - 当 run 无显式路由配置时，可回退纳入 `run.tasks.ownerRole` 参与推导
  - 当 run 有显式路由配置时，不使用 `run.tasks.ownerRole` 扩展 enabled 角色集合（避免历史脏任务污染）

---

## 5. 对外 API 契约

### 5.1 Run 生命周期

- `GET /api/workflow-runs`
- `POST /api/workflow-runs`
- `GET /api/workflow-runs/:run_id`
- `DELETE /api/workflow-runs/:run_id`
- `POST /api/workflow-runs/:run_id/start`
- `POST /api/workflow-runs/:run_id/stop`
- `GET /api/workflow-runs/:run_id/status`

### 5.2 Template 管理

- `GET /api/workflow-templates`
- `GET /api/workflow-templates/:template_id`
- `POST /api/workflow-templates`
- `PATCH /api/workflow-templates/:template_id`
- `DELETE /api/workflow-templates/:template_id`

### 5.3 Runtime / Tree / Detail

- `GET /api/workflow-runs/:run_id/task-runtime`
- `GET /api/workflow-runs/:run_id/task-tree-runtime`
- `GET /api/workflow-runs/:run_id/task-tree`
- `GET /api/workflow-runs/:run_id/tasks/:task_id/detail`

### 5.4 会话、消息、调度

- `GET /api/workflow-runs/:run_id/sessions`
- `POST /api/workflow-runs/:run_id/sessions`
- `POST /api/workflow-runs/:run_id/messages/send`
- `GET /api/workflow-runs/:run_id/agent-io/timeline`
- `GET /api/workflow-runs/:run_id/orchestrator/settings`
- `PATCH /api/workflow-runs/:run_id/orchestrator/settings`
- `POST /api/workflow-runs/:run_id/orchestrator/dispatch`
- `GET /api/workflow-orchestrator/status`

### 5.5 Team Tool 角色路由查询（状态：实装）

- `route_targets_get`（Team Tool）
  - `enabledAgents` 仅来自当前 run 角色集合。
  - `allowedTargets` 在 `enabledAgents` 基座上按 run 路由规则裁剪。
  - 不返回全局 registry 的外部角色。

### 5.6 退役接口

- `GET /api/workflow-runs/:run_id/step-runtime` -> `410`
- `POST /api/workflow-runs/:run_id/step-actions` -> `410`

---

## 6. 可观测事件

关键事件族：

- 调度：
  - `ORCHESTRATOR_DISPATCH_STARTED`
  - `ORCHESTRATOR_DISPATCH_FINISHED`
  - `ORCHESTRATOR_DISPATCH_FAILED`
- task action：
  - `TASK_ACTION_RECEIVED`
  - `TASK_REPORT_APPLIED`
- 结束窗口：
  - `ORCHESTRATOR_RUN_AUTO_FINISH_WINDOW_TICK`
  - `ORCHESTRATOR_RUN_AUTO_FINISH_WINDOW_RESET`
  - `ORCHESTRATOR_RUN_AUTO_FINISHED`
- 超时与提醒：
  - `SESSION_HEARTBEAT_TIMEOUT`
  - `RUNNER_TIMEOUT_SOFT`
  - `RUNNER_TIMEOUT_ESCALATED`
  - `ORCHESTRATOR_ROLE_REMINDER_TRIGGERED`
  - `ORCHESTRATOR_ROLE_REMINDER_REDISPATCH`

---

## 7. 测试覆盖（当前）

- `server/src/__tests__/workflow-task-runtime-api.test.ts`
- `server/src/__tests__/workflow-task-actions.test.ts`
- `server/src/__tests__/workflow-block-propagation.test.ts`
- `server/src/__tests__/workflow-parent-state-align.test.ts`
- `server/src/__tests__/workflow-session-timeout-recovery.test.ts`

## API Path Registry (docs:check)

Workflow runtime endpoints (exact path contract):

- `GET /api/workflow-orchestrator/status`
- `GET /api/workflow-templates`
- `GET /api/workflow-templates/:template_id`
- `POST /api/workflow-templates`
- `PATCH /api/workflow-templates/:template_id`
- `DELETE /api/workflow-templates/:template_id`
- `GET /api/workflow-runs/:run_id/task-runtime`
- `GET /api/workflow-runs/:run_id/task-tree-runtime`
- `GET /api/workflow-runs/:run_id/task-tree`
- `GET /api/workflow-runs/:run_id/tasks/:task_id/detail`
- `POST /api/workflow-runs/:run_id/task-actions`
- `POST /api/workflow-runs/:run_id/start`
- `POST /api/workflow-runs/:run_id/stop`
- `GET /api/workflow-runs/:run_id/status`
