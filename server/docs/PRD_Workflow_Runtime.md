# Workflow Runtime 模块 PRD

## 1. 模块目标

Workflow Runtime 模块负责 workflow run 的运行态模型、状态迁移和可观测接口，覆盖：

- workflow run 生命周期（create/start/stop/status）
- step 运行态（state / blockers / transitions）
- 依赖门禁（blocked -> ready 解阻传播）
- workflow task tree + runtime 视图

对应源码：

- `server/src/services/workflow-orchestrator-service.ts`
- `server/src/data/workflow-store.ts`
- `server/src/app.ts`
- `server/src/domain/models.ts`

## 2. 关键模型

### 2.1 Step 状态机

`WorkflowStepState`:

- `CREATED`
- `READY`
- `BLOCKED_DEP`
- `IN_PROGRESS`
- `DONE`
- `CANCELED`
- `FAILED`

### 2.2 Block reason

`WorkflowBlockReasonCode`:

- `DEP_UNSATISFIED`
- `RUN_NOT_RUNNING`
- `INVALID_TRANSITION`
- `STEP_NOT_FOUND`
- `STEP_ALREADY_TERMINAL`

### 2.3 运行态快照

`WorkflowRunRuntimeSnapshot`:

- `runId`
- `status` (`created|running|stopped|finished|failed`)
- `active`
- `updatedAt`
- `counters` (`total/ready/blocked/inProgress/done/failed/canceled`)
- `steps[]`（每步含 state、blockedBy、blockedReasons、lastTransitionAt、transitionCount、transitions）

## 3. API 契约

### 3.1 Runtime 查询

- `GET /api/workflow-runs/:run_id/step-runtime`
- `GET /api/workflow-runs/:run_id/task-tree-runtime`

返回：

- run 状态 + active
- counters
- step runtime 明细（task-tree-runtime 以节点 `runtime` 字段返回）

### 3.2 Step Action

- `POST /api/workflow-runs/:run_id/step-actions`

请求：

- `action_type=STEP_REPORT`
- `from_agent?`
- `results[]`:
  - `task_id`
  - `outcome` (`IN_PROGRESS|BLOCKED_DEP|DONE|CANCELED|FAILED`)
  - `summary?`
  - `blockers?[]`

响应：

- `success`
- `requestId`
- `partialApplied`
- `appliedTaskIds`
- `rejectedResults[]`
- `snapshot`

### 3.3 Run 生命周期

- `POST /api/workflow-runs/:run_id/start`
- `POST /api/workflow-runs/:run_id/stop`
- `GET /api/workflow-runs/:run_id/status`
- `GET /api/workflow-orchestrator/status`

## 4. 行为规则

1. Run create 时初始化 step 为 `CREATED`（缺失 runtime 时懒初始化）。
2. Run start 时评估依赖：
   - 依赖满足 -> `READY`
   - 依赖未满足 -> `BLOCKED_DEP`
3. Step action 只在 run=`running` 时接受；否则 `RUN_NOT_RUNNING`。
4. Step 进入终态后触发全图重评估，推进后继解阻。
5. Run stop 后 active=false，编排器 activeRunIds 移除该 run。

## 5. 错误与边界

- `WORKFLOW_RUN_NOT_FOUND`
- `WORKFLOW_TEMPLATE_NOT_FOUND`
- `RUN_NOT_RUNNING`
- `STEP_NOT_FOUND`
- `STEP_ALREADY_TERMINAL`
- `INVALID_TRANSITION`

## 6. 前端集成约定

Workflow 页面默认以 workflow 原生 runtime API 为主，不依赖 project task-tree 作为权威状态源。

推荐轮询：

- `step-runtime/task-tree-runtime`: 5 秒（run=running）
- run 非 running 时停止轮询并显示静态快照

## 7. 测试覆盖

- `server/src/__tests__/workflow-step-runtime-api.test.ts`
- `server/src/__tests__/workflow-step-actions.test.ts`
- `server/src/__tests__/workflow-block-propagation.test.ts`

## API Path Registry (docs:check)

Workflow template endpoints (exact path contract):

- `GET /api/workflow-templates`
- `GET /api/workflow-templates/:template_id`
- `POST /api/workflow-templates`
- `PATCH /api/workflow-templates/:template_id`
- `DELETE /api/workflow-templates/:template_id`
