# Orchestrator 模块 PRD

## 1. 模块目标

### 模块状态

- `实装`

### 模块职责

Project Orchestrator 负责 project runtime 的编排闭环，覆盖：

- role/session 级 dispatch 与 message dispatch
- session timeout repair / dismiss
- reminder 与 MAY_BE_DONE 推进
- auto dispatch 预算、hold 与单飞保护
- timeline 可回放事件输出

### 主要源码

- `server/src/services/orchestrator/project-orchestrator.ts`
- `server/src/services/orchestrator/project-dispatch-service.ts`
- `server/src/services/orchestrator/project-dispatch-loop-adapter.ts`
- `server/src/services/orchestrator/project-dispatch-session-helper.ts`
- `server/src/services/orchestrator/project-dispatch-selection-adapter.ts`
- `server/src/services/orchestrator/project-dispatch-prompt-context.ts`
- `server/src/services/orchestrator/project-dispatch-prompt.ts`
- `server/src/services/orchestrator/project-dispatch-launch-adapter.ts`
- `server/src/services/orchestrator/project-dispatch-launch-execution-types.ts`
- `server/src/services/orchestrator/project-dispatch-launch-helper-service.ts`
- `server/src/services/orchestrator/project-dispatch-launch-minimax.ts`
- `server/src/services/orchestrator/project-dispatch-launch-sync.ts`
- `server/src/services/orchestrator/project-dispatch-launch-preparation.ts`
- `server/src/services/orchestrator/project-dispatch-launch-support.ts`
- `server/src/services/orchestrator/project-orchestrator-options.ts`
- `server/src/services/orchestrator/project-session-runtime-service.ts`
- `server/src/services/orchestrator/project-session-runtime-timeout.ts`
- `server/src/services/orchestrator/project-session-runtime-termination.ts`
- `server/src/services/orchestrator/project-reminder-service.ts`
- `server/src/services/orchestrator/project-completion-service.ts`
- `server/src/services/orchestrator/project-tick-service.ts`
- `server/src/services/orchestrator/project-message-routing-service.ts`
- `server/src/services/manager-routing-event-service.ts`
- `server/src/services/orchestrator/shared/dispatch-template.ts`
- `server/src/services/orchestrator/shared/launch-template.ts`
- `server/src/services/orchestrator/shared/orchestrator-identifiers.ts`
- `server/src/services/orchestrator/shared/orchestrator-env.ts`
- `server/src/services/orchestrator/shared/orchestrator-runtime-helpers.ts`
- `server/src/services/orchestrator/shared/orchestrator-agent-catalog.ts`
- `server/src/services/orchestrator/shared/tool-session-input.ts`
- `server/src/services/orchestrator/shared/role-prompt-skill-bundle.ts`
- `server/src/services/orchestrator/shared/tick-pipeline.ts`
- `server/src/services/orchestrator/index.ts`

## 2. 对外行为

### 2.1 API

- `POST /api/projects/:id/orchestrator/dispatch`
- `POST /api/projects/:id/orchestrator/dispatch-message`
- `GET /api/projects/:id/orchestrator/settings`
- `PATCH /api/projects/:id/orchestrator/settings`

### 2.2 稳定约束

- 对外 API path、payload、status code、SSE、event type、task state name 保持不变。
- 退役接口继续返回 `410`。
- `server/src/services/orchestrator/index.ts` 继续稳定导出：
  - `OrchestratorService`
  - `createOrchestratorService`
  - `resolveTaskDiscuss`
  - `calculateNextReminderTime`
  - `shouldAutoResetReminderOnRoleTransition`

## 3. 结构分层

### 3.1 Façade

- `project-orchestrator.ts`
- 只负责 service 装配、loop 启停、兼容导出与 public façade。

### 3.2 Pure Policy

- `project-dispatch-policy.ts`
- `project-reminder-policy.ts`
- `project-completion-policy.ts`

规则模块不直接读写存储，不构造 HTTP payload。

### 3.3 Application Services

- `project-dispatch-service.ts`
- `project-session-runtime-service.ts`
- `project-reminder-service.ts`
- `project-completion-service.ts`
- `project-tick-service.ts`

application service 是编排副作用与 UnitOfWork 边界的唯一入口。

## 4. Dispatch 规则

### 4.1 Dispatch 入口

- 手工 dispatch
- 手工 dispatch-message
- loop auto dispatch

### 4.2 Dispatch 选择

- `project-dispatch-selection-adapter.ts` 负责：
  - explicit message candidate
  - task candidate / force task
  - dependency gate
  - duplicate open dispatch
  - onlyIdle / session_busy
- 输出 normalized selection result，service 不再手拼散字段。

### 4.3 Dispatch Prompt

- `project-dispatch-prompt-context.ts` 负责组装 stable prompt context。
- `project-dispatch-prompt.ts` 只消费 context 做 renderer。
- prompt 必须包含：
  - focus task
  - actionable / blocked tasks
  - dependency readiness
  - routing snapshot
  - discuss guide

### 4.4 Dispatch 执行骨架

- `shared/dispatch-template.ts` 是当前 project/workflow 共用的 dispatch skeleton。
- shared skeleton 统一负责：
  - preflight gate 顺序
  - dispatch loop / maxDispatches
  - single-flight gate
  - skipped / dispatched / busy / no-task 结果归一
- project adapter 继续负责：
  - authoritative session 解析
  - force dispatch bootstrap
  - cooldown 与 role-level ordering
  - project runtime side effect

### 4.5 Launch 执行骨架

- `shared/launch-template.ts` 是当前 project/workflow 共用的 launch skeleton。
- shared skeleton 统一负责：
  - started phase
  - execute / failure trap
  - success / failure handler 收口
- `project-dispatch-launch-adapter.ts` 继续负责：
  - provider 选择
  - shared launch-template 接线
  - payload/build glue
- `project-dispatch-launch-helper-service.ts` 当前负责：
  - runner success / timeout / fatal 处理
- `project-dispatch-launch-minimax.ts` 当前负责：
  - MiniMax wake-up / completion callback
- `project-dispatch-launch-sync.ts` 当前负责：
  - Codex resume / fallback
- `project-dispatch-launch-preparation.ts` 负责：
  - provider/model enrichment
  - workspace/bootstrap
  - prompt artifact persistence
- `project-dispatch-launch-support.ts` 负责：
  - event payload builder
  - runner payload builder
  - terminal dispatch event append
- `manager-routing-event-service.ts` 当前负责 project/workflow 共用的 route event payload contract builder，避免 `USER_MESSAGE_RECEIVED` / `MESSAGE_ROUTED` 字段规则在不同编排器侧继续分叉。
- `project-orchestrator-options.ts` 与 `shared/orchestrator-env.ts` 当前负责 project/workflow 共用的 env/options 解析门限，避免两个 orchestrator 工厂各自重复解析环境变量。
- `shared/orchestrator-identifiers.ts` 当前负责跨 project/workflow 复用的 session/request/message/reminder identifier 规则，减少 role session id 与 timestamp-based id 的分叉实现。
- `shared/orchestrator-runtime-helpers.ts` 当前负责 project/workflow 共用的 agent workspace 路径、`.minimax/sessions` fallback、provider session fallback 与 manager URL 默认值，避免 launch path 与 agent-chat route 再各自手拼运行时路径。

### 4.6 Force Dispatch

- `force=true + task_id` 时，先校验 task 是否存在且状态 force-dispatchable。
- 无 active owner session 时可自动 bootstrap owner session。
- 非 force-dispatchable 状态直接返回 `task_not_force_dispatchable`。

### 4.7 结果语义

常见 outcome：

- `dispatched`
- `no_message`
- `message_not_found`
- `task_not_found`
- `task_not_force_dispatchable`
- `task_already_done`
- `task_owner_mismatch`
- `already_dispatched`
- `session_busy`
- `session_not_found`
- `dispatch_failed`

## 5. Tick 规则

project tick 固定顺序：

1. `timeout`
2. `reminder`
3. `may-be-done`
4. `observability snapshot`
5. `auto-dispatch remaining update`

- tick path 通过 `shared/tick-pipeline.ts` 执行公共骨架。
- role reminder 状态继续保存在 project runtime 文档，不新增独立 reminder store。

## 6. 事务与数据边界

- route 层只做 HTTP 解析、校验、响应映射，不直接开事务。
- 同一用例内的 taskboard、session、event、inbox、project runtime 写入必须落在同一 UnitOfWork 边界。
- façade 与 route 不得直接依赖底层 file util 或 `runStorageTransaction`。
- orchestrator service 不得直接构造 HTTP 风格响应。

## 7. 验证基线

- `pnpm --filter @autodev/server build`
- `pnpm --filter @autodev/server test`

当前 shared dispatch/launch skeleton 已在 project 主路径实装并通过上述验证。
