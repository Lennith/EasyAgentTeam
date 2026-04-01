# Task 协议模块 PRD (Task V2)

## 1. 模块目标

### 模块状态

- `实装`

### 本轮收敛约束（2026-03-29）

- 仅收敛既有实现边界，不新增 shared contract 名词或第二套契约体系。
- task-action 主链路继续向 repository/UoW 入口收敛，逐步去除直连底层 store 的调用点。

### 模块职责

Task 协议模块定义任务驱动协作的统一写入入口、状态机、依赖门禁与任务查询能力。

**源码路径**:

- `server/src/services/task-action-service.ts`
- `server/src/services/task-actions/**`
- `server/src/services/task-actions/assignment-processing.ts`
- `server/src/services/task-actions/update-processing.ts`
- `server/src/services/task-actions/discuss-processing.ts`
- `server/src/services/task-actions/report-processing.ts`
- `server/src/data/taskboard-store.ts`
- `server/src/services/task-tree-query-service.ts`
- `server/src/services/task-detail-query-service.ts`
- `server/src/services/task-progress-validation-service.ts`
- `server/src/services/task-creator-terminal-report-service.ts`

### 解决问题

- 统一任务创建/指派/讨论/上报协议
- 保证依赖关系正确性（含祖先依赖禁用）
- 防止依赖未满足任务被误上报为推进态，污染运行态时间线与阶段顺序判定
- 提供可回放的任务树与生命周期详情

### 业务价值

- 协作流程从消息驱动升级为任务驱动
- 任务状态更可解释、更可审计

---

## 2. 功能范围

### 包含能力

- `POST /api/projects/:id/task-actions`
  - `TASK_CREATE`
  - `TASK_UPDATE`
  - `TASK_ASSIGN`
  - `TASK_DISCUSS_REQUEST`
  - `TASK_DISCUSS_REPLY`
  - `TASK_DISCUSS_CLOSED`
  - `TASK_REPORT`
- `GET /api/projects/:id/task-tree`
- `GET /api/projects/:id/tasks/:task_id/detail`
- `TASK_REPORT` partial apply（owner/creator 规则）
- Creator terminal 汇总回告

### 不包含能力

- 会话调度策略（由 orchestrator 负责）
- 消息路由协议（由 manager-message-service 负责）

---

## 3. 对外行为

### 3.1 输入

#### 写入入口

- `POST /api/projects/:id/task-actions`

#### 查询入口

- `GET /api/projects/:id/task-tree`
- `GET /api/projects/:id/tasks/:task_id/detail`

### 3.2 输出

- action 结果：`success/requestId/actionType/taskId/errorCode`
- report 成功附加：
  - `partialApplied`
  - `appliedTaskIds`
  - `rejectedResults`
- `TASK_REPORT` 协议（硬切）：
  - 仅接受 `results[]`
  - `results[].outcome` 仅允许：`IN_PROGRESS | BLOCKED_DEP | DONE | CANCELED`
  - `report_mode` 与旧值 `PARTIAL/BLOCKED/FAILED` 已退役并返回 400

---

## 4. 内部逻辑

### 核心处理规则

#### 4.1 依赖合法性

- 禁止依赖引用 parent 或任何 ancestor。
- 违规返回：`TASK_DEPENDENCY_ANCESTOR_FORBIDDEN`（409）。

#### 4.2 Runnable 与父子聚合

- runnable 以依赖门禁与状态计算为准。
- 父任务状态由直接子任务聚合更新。

#### 4.3 TASK_REPORT 授权与部分成功（状态：实装）

- 上报资格：`owner_role == from_agent` 或 `creator_role == from_agent`。
- 批量上报逐条校验，常规错误允许部分成功。
- 依赖门禁为硬约束：当任一 result 试图将依赖未满足任务上报为推进态（`IN_PROGRESS | MAY_BE_DONE | DONE`）时，整次请求直接拒绝（409）。
- 同批次 `results[]` 采用顺序语义：前序已通过校验并可应用的结果会先更新同批次预测状态，后序 result 的依赖判断基于该预测状态执行。
- 因此，同批次内若先上报依赖任务 `DONE/CANCELED`，后续依赖该任务的推进态上报可在同一请求内通过门禁。
- 依赖未满足任务允许上报 `BLOCKED_DEP`。
- 状态迁移规则：`DONE/CANCELED` 仅允许同状态重复上报，不允许回退。
- 依赖门禁拒绝返回 `TASK_DEPENDENCY_NOT_READY`，并返回：
  - `task_id`
  - `dependency_task_ids`
  - 任务当前状态与目标状态
  - 明确等待依赖完成与撤回/降级冲突内容的提示
- 全部拒绝返回 409（`TASK_RESULT_INVALID_TARGET` 或 `TASK_STATE_STALE`）。
- task-action 主链路写入（taskboard/session/event/route-target resolve）已通过 `ProjectRepositoryBundle` 收口，不再扩散直连底层 store 写入。
- `TASK_ASSIGNMENT` 消息构造统一由 `task-actions/shared.ts` 提供，task-action 与 project dispatch selection 共用同一字段装配逻辑。
- `TASK_CREATE/TASK_ASSIGN` 的 assignment owner 解析与写后收口已下沉到 `task-actions/assignment-processing.ts`，`handlers.ts` 仅保留 action wiring。
- `TASK_UPDATE` 主流程已下沉到 `task-actions/update-processing.ts`，`handlers.ts` 仅负责写上下文与 action 分发。
- `TASK_DISCUSS_*` 主流程已下沉到 `task-actions/discuss-processing.ts`，`handlers.ts` 不再内嵌目标解析与路由细节。
- `TASK_REPORT` 的 accepted/rejected 规则评估已下沉到 `task-actions/report-processing.ts`，handler 仅保留写上下文编排与副作用收口。

#### 4.4 progress 校验

- DONE/BLOCK 强校验 `progress.md`。
- 校验失败返回 `TASK_PROGRESS_REQUIRED`。

#### 4.5 终结回告

- creator + parentTask 维度全终结后触发系统汇总通知。

---

## 5. 依赖关系

### 上游依赖

- `server/src/data/repository/project-repository-bundle.ts`
- `server/src/data/repository/taskboard-repository.ts`
- `server/src/data/repository/session-repository.ts`
- `server/src/data/repository/event-repository.ts`
- `server/src/data/repository/inbox-repository.ts`

### 下游影响

- orchestrator runnable 任务选择
- dashboard task-tree/task-detail 展示

---

## 6. 约束条件

- 任务状态机：`PLANNED/READY/DISPATCHED/IN_PROGRESS/BLOCKED_DEP/MAY_BE_DONE/DONE/CANCELED`
- 退役接口保持 410（handoff/reports/tasks）。
- Task 协议为唯一主写入口。

---

## 7. 异常与边界

| 场景               | 错误码                               |
| ------------------ | ------------------------------------ |
| 祖先依赖非法       | `TASK_DEPENDENCY_ANCESTOR_FORBIDDEN` |
| 路由越权           | `TASK_ROUTE_DENIED`                  |
| 上报目标非法       | `TASK_RESULT_INVALID_TARGET`         |
| 上报状态滞后       | `TASK_STATE_STALE`                   |
| 依赖未满足推进上报 | `TASK_DEPENDENCY_NOT_READY`          |
| progress 证据不足  | `TASK_PROGRESS_REQUIRED`             |

---

## 8. 数据定义

### 关键实体

- `TaskRecord`
- `TaskActionRequest/TaskActionResult`
- `TaskTreeResponse`
- `TaskDetailResponse`

### 关键事件

- `TASK_ACTION_RECEIVED`
- `TASK_ACTION_REJECTED`
- `TASK_REPORT_APPLIED`
- `TASK_CREATOR_TERMINAL_REPORT_SENT`

> `TASK_REPORT_APPLIED` 不再携带 `aggregateStatus`，只保留 `applied/updated/rejected` 结果明细字段。

---

## 9. 当前状态

- 本模块当前无阻塞待确认项，按现有协议继续执行。

## 10. 当前实装快照（2026-03-29）

- `TASK_CREATE/TASK_ASSIGN`
  - 执行主体：`server/src/services/task-actions/assignment-processing.ts`
  - `handlers.ts` 仅负责写上下文与 action 分发
  - owner role/session 解析、写后统一流程（recompute + event + assignment route）在 processing 中集中实现
- `TASK_UPDATE`
  - 执行主体：`server/src/services/task-actions/update-processing.ts`
  - patch 解析、写入与 `TASK_UPDATED` 事件写入在 processing 中集中实现
- `TASK_DISCUSS_*`
  - 执行主体：`server/src/services/task-actions/discuss-processing.ts`
  - 目标解析、route gate、route message 执行集中在 processing 中实现
- `TASK_REPORT`
  - 执行主体：`server/src/services/task-actions/report-processing.ts`
  - 通过 shared pipeline 固定 `parse -> authorize -> gate -> apply -> emit`
  - `TASK_PROGRESS_VALIDATION_FAILED` 与 `TASK_REPORT_APPLIED` 事件语义保持不变
- 外部协议冻结保持不变：
  - API path/payload/status code、错误码、事件类型不变
- 验证基线：
  - `pnpm --filter @autodev/server build` 通过
  - `pnpm --filter @autodev/server test` 通过
