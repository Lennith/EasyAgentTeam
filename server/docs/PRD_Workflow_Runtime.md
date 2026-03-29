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

- `server/src/services/orchestrator/workflow-orchestrator.ts`
- `server/src/services/orchestrator/workflow-orchestrator-composition.ts`
- `server/src/services/orchestrator/workflow-orchestrator-options.ts`
- `server/src/services/orchestrator/workflow-orchestrator-types.ts`
- `server/src/services/orchestrator/workflow-runtime-support-service.ts`
- `server/src/services/orchestrator/workflow-orchestrator-status-service.ts`
- `server/src/services/orchestrator/workflow-run-lifecycle-service.ts`
- `server/src/services/orchestrator/workflow-run-query-service.ts`
- `server/src/services/orchestrator/workflow-dispatch-service.ts`
- `server/src/services/orchestrator/workflow-dispatch-loop-adapter.ts`
- `server/src/services/orchestrator/workflow-dispatch-selection-adapter.ts`
- `server/src/services/orchestrator/workflow-dispatch-prompt-context.ts`
- `server/src/services/orchestrator/workflow-dispatch-provider-runner.ts`
- `server/src/services/orchestrator/workflow-session-runtime-service.ts`
- `server/src/services/orchestrator/workflow-session-runtime-timeout.ts`
- `server/src/services/orchestrator/workflow-reminder-service.ts`
- `server/src/services/orchestrator/workflow-completion-service.ts`
- `server/src/services/orchestrator/workflow-tick-service.ts`
- `server/src/services/orchestrator/workflow-task-action-service.ts`
- `server/src/services/orchestrator/workflow-message-routing-service.ts`
- `server/src/services/orchestrator/workflow-runtime-view.ts`
- `server/src/services/manager-routing-event-service.ts`
- `server/src/services/orchestrator/shared/tick-pipeline.ts`
- `server/src/services/orchestrator/shared/orchestrator-identifiers.ts`
- `server/src/services/orchestrator/shared/orchestrator-env.ts`
- `server/src/services/orchestrator/shared/orchestrator-runtime-helpers.ts`
- `server/src/services/orchestrator/shared/orchestrator-agent-catalog.ts`
- `server/src/services/orchestrator/shared/tool-session-input.ts`
- `server/src/services/orchestrator/shared/role-prompt-skill-bundle.ts`
- `server/src/services/orchestrator/workflow-dispatch-policy.ts`
- `server/src/services/orchestrator/workflow-dispatch-prompt.ts`
- `server/src/services/orchestrator/kernel/orchestrator-kernel.ts`
- `server/src/services/orchestrator/kernel/single-flight.ts`
- `server/src/services/orchestrator/dispatch-engine.ts`
- `server/src/services/orchestrator/session-manager.ts`
- `server/src/services/orchestrator/reminder-service.ts`
- `server/src/services/orchestrator/runtime/workflow-runtime-kernel.ts`
- `server/src/services/orchestrator/runtime/workflow-auto-finish-window.ts`
- `server/src/services/orchestrator/index.ts`
- `server/src/data/repository/workflow-repository-bundle.ts`
- `server/src/data/repository/workflow-run-repository.ts`
- `server/src/data/repository/workflow-session-repository.ts`
- `server/src/data/repository/workflow-event-repository.ts`
- `server/src/data/repository/workflow-inbox-repository.ts`
- `server/src/data/repository/workflow-reminder-repository.ts`
- `server/src/domain/models.ts`
- `server/src/routes/workflow-routes.ts`

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

### 3.0 P0-2 改造说明（状态：实装）

- 本轮将 Workflow 与 Project 编排器实现收敛到统一 `orchestrator/` 目录。
- 共性逻辑（单飞行保护、会话状态收敛、提醒时间计算）下沉到共享模块。
- `workflow-orchestrator.ts` 当前继续向 façade 收敛；run lifecycle 已下沉到 `workflow-run-lifecycle-service.ts`，runtime/task-tree/settings query 兼容入口已下沉到 `workflow-run-query-service.ts`。MAY_BE_DONE 与自动结束窗口下沉到独立 completion service，tick 顺序编排下沉到独立 tick service，并通过 shared tick pipeline 执行公共 phase 骨架。
- `sessionRuntime/reminder/completion` 已通过 shared adapter contract 接入 shared tick pipeline，workflow tick service 当前主要负责 workflow scope 装配与 hold/event/budget 差异收口，phase 顺序保持不变。
- dispatch loop 当前已通过 `shared/dispatch-template.ts` 收敛统一骨架；workflow service 只保留 run/hold/budget/concurrency preflight、selection/mutation/finalize adapter 组装。
- launch 主流程当前已通过 `shared/launch-template.ts` 收敛统一骨架；workflow launch adapter 只保留 workflow provider/tool/runtime 差异。
- ProviderRegistry 仅允许在应用 composition root 创建并注入，编排器内部不再隐式创建默认实例。
- 外部行为兼容保持冻结：API 路径、payload、状态码、事件字段语义不变。

### 3.1 Tick 范围

- 仅处理 `run.status == running` 的 run。
- 每个 tick 顺序执行：
  1. 载入 runtime/session
  2. 处理 running session 超时
  3. 自动结束窗口判定
  4. hold 判定
  5. reminder 与 MAY_BE_DONE 检查
  6. auto dispatch

### 3.2 依赖与父任务聚合（状态：实装）

- 依赖未满足的 task 进入 `BLOCKED_DEP`。
- 依赖满足后可进入 `READY`。
- 父任务状态由子任务聚合：
  - 子任务全 `DONE/CANCELED` => 父任务 `DONE`
  - 依赖不满足 => 父任务 `BLOCKED_DEP`
  - 其他情况 => 父任务 `IN_PROGRESS`
- 依赖未满足任务不会因误上报形成有效推进态；推进态上报在 report 入口即被拦截。

- 依赖门禁、父任务聚合、runtime 收敛由纯内核函数执行，不直接依赖文件读写。
- orchestrator 对 runtime 的落盘必须基于事务内最新 run/runtime 快照，避免 loop tick 与 task-actions 互相覆盖旧状态。

### 3.3 自动结束策略（稳定窗口，状态：实装）

- 手工 `stop`：立即结束 run（状态 `stopped`）。
- 自动结束：满足以下条件并连续 2 个 tick 后置为 `finished`：
  - 所有 session 均不在 `running`
  - 不存在未完成 task
- 未完成 task 定义：状态不属于 `DONE/CANCELED`（即 `BLOCKED_DEP` 也算未完成）。
- 若中途条件不满足，稳定窗口计数清零。

- 自动结束稳定窗口判定由纯函数执行，保证同样输入下结果确定。

### 3.4 调度规则（状态：实装）

- 调度入口：loop 自动调度 + 手工 dispatch。
- 任务候选统一按 `depth desc -> priority desc -> createdAt asc -> taskId asc` 选择。
- 同一 role 下若祖先任务与后代任务同时可派发，优先后代（树更深节点）。
- 任务绑定消息命中多个 task 候选时，按同一优先级规则决策 task。
- 关键约束：
  - `run.status != running` 时，dispatch 返回 `run_not_running`。
  - loop 模式下，`hold_enabled=true` 时不执行任务调度。
  - auto dispatch 预算由 `auto_dispatch_enabled + auto_dispatch_remaining` 控制。
  - session 单飞保护与最大并发数限制同时生效。

- dispatch side 的 shared lifecycle seam 已前推：统一单飞 gate、dispatch lifecycle 公共字段和 dispatch closed/timed-out 判定；dispatch lifecycle 主链事件落盘已从 workflow service 主体中剥离到 adapter。
- `workflow-dispatch-service.ts` 当前通过 shared dispatch template 执行统一 dispatch loop；service 主体只保留 run/status/hold/budget/concurrency preflight、selection adapter、prelaunch mutation、post-loop runtime writeback。
- `workflow-dispatch-launch-adapter.ts` 当前通过 shared launch template 执行 started/success/failure skeleton；adapter 主体只保留 workflow-specific launch context、prompt build、tool bridge 与 provider run。
- `shared/runner-template.ts` 已作为 launch skeleton 的底层生命周期执行器，统一 started/success/failure/timeout/escalation 分支收口，`workflow-dispatch-launch-adapter.ts` 不再自持这套执行骨架。
- `workflow-dispatch-selection-adapter.ts` 负责 role set、authoritative session、busy/cooldown/onlyIdle、message/task 选择、duplicate open dispatch、budget eligibility，并输出 normalized selection result。
- `workflow-dispatch-prompt-context.ts` 负责 focus task、dependency states、visible actionable/blocked tasks、message content、workspace contract 的 stable context；`workflow-dispatch-prompt.ts` 只消费该 context 进行 renderer。
- workflow launch preparation 已从 `workflow-dispatch-launch-adapter.ts` 下沉到独立 helper seam（`workflow-dispatch-launch-preparation.ts`），统一收口 agent/workspace bootstrap、skill prompt 解析和 provider/model 预备；launch adapter 保留 started/finished/failed 生命周期和 provider run 协调。
- workflow launch adapter 内的 max-tokens event enrichment、dispatch close/time-out 收口、finished/failed terminal 处理已下沉到独立 helper（`workflow-dispatch-launch-support.ts`），`workflow-dispatch-launch-adapter.ts` 进一步收敛为 launch preparation、prompt build 和 provider run 协调层。
- workflow message routing 的 target session resolve、message envelope 组装、inbox/event 落盘已从 `workflow-dispatch-service.ts` 下沉到 `workflow-message-routing-service.ts`，`sendRunMessage` 当前仅做 façade 级委托。
- `workflow-message-routing-service.ts` 当前通过 `shared/message-routing-template.ts` 统一执行 `resolve -> envelope -> inbox -> route-event -> session-touch` 顺序，workflow 仅保留路由权限与 envelope 策略差异。
- workflow `USER_MESSAGE_RECEIVED` / `MESSAGE_ROUTED` 的 compact payload builder 已与 `manager-routing-event-service.ts` 对齐到同一共享实现，字段语义保持 workflow 现状不变。
- `workflow-orchestrator.ts` 中的 snapshot/settings/task-tree 视图 helper 已下沉到 `workflow-runtime-view.ts`，query/runtime 响应继续保持原有字段语义不变。
- run `start/stop/status` 生命周期与 runtime/task-tree/settings query 兼容路径已从 `workflow-orchestrator.ts` 下沉到 `workflow-run-lifecycle-service.ts` 与 `workflow-run-query-service.ts`，orchestrator 入口继续保持 façade 语义。
- runtime load/converge/ensure 事务胶水与 snapshot 构造已收口到 `workflow-runtime-support-service.ts`，orchestrator 不再直接拼装 repository runtime 读写。
- orchestrator status 视图已收口到 `workflow-orchestrator-status-service.ts`，`workflow-orchestrator.ts` 继续只保留 façade 级状态委托。
- `applyTaskActions` 的 discuss/TASK_CREATE/TASK_REPORT 路径已从 `workflow-orchestrator.ts` 下沉到 `workflow-task-action-service.ts`，orchestrator 当前仅保留 façade 级委托，task-actions API、timeline 和 event 语义保持不变。
- `workflow-task-action-service.ts` 当前通过 `shared/task-action-template.ts` 执行 `parse -> auth -> dependency gate -> apply -> converge -> emit` 流程骨架，workflow 仅保留 task-state 与 runtime 收敛规则。
- workflow orchestrator 的 env/options 解析与 service composition 已下沉到 `workflow-orchestrator-options.ts` 与 `workflow-orchestrator-composition.ts`，`workflow-orchestrator.ts` 当前主要保留 façade 级委托和兼容 wrapper。
- 与 project 共用的 orchestrator env/options 解析规则已统一到 `shared/orchestrator-env.ts`，避免双份环境变量门限逻辑漂移。
- workflow dispatch、message routing 与 reminder 当前已复用 `shared/orchestrator-identifiers.ts` 生成 requestId/messageId/reminderId；role session id 也复用同一 helper，避免 workflow 侧继续维护独立 identifier 规则。
- workflow launch path、prompt workspace path、session cancel fallback 与 agent-chat route 当前已复用 `shared/orchestrator-runtime-helpers.ts`，统一 `Agents/<role>`、`.minimax/sessions`、provider session fallback 与 manager URL 默认值。
- workflow launch preparation 与 workspace bootstrap 当前已复用 `shared/orchestrator-agent-catalog.ts` 生成 `agentIds/rolePromptMap/roleSummaryMap`，避免 project/workflow 继续各自手工维护 agent metadata 映射。
- workflow dispatch launch 与 project/workflow agent-chat 当前已复用 `shared/tool-session-input.ts` 组装 `runSessionWithTools` 的 MiniMax base input，避免 tool-session 字段在多条 launch path 再次分叉。
- workflow dispatch launch preparation 与 project/workflow agent-chat 当前已复用 `shared/role-prompt-skill-bundle.ts` 解析 role prompt 与 imported skill segments，避免 role prompt / skill bundle 在 launch path 再次分叉。

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
- `TASK_CREATE` 的 `dependencies` 不允许包含父任务或任何祖先任务（与 project create 依赖祖先校验对齐）。
- 违反上述约束时，接口直接拒绝并返回依赖祖先冲突错误码与冲突 task 列表。

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
