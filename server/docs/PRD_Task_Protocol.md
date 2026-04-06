# Task 协议模块 PRD

## 1. 模块目标

### 模块状态

- `验证中`

### 模块职责

- 作为 `project runtime` 唯一任务写入口，统一承载 `TASK_CREATE/TASK_UPDATE/TASK_ASSIGN/TASK_DISCUSS_*/TASK_REPORT`。
- 定义任务状态机与依赖合法性门禁，保证任务链路可验证、可回放。
- 提供 task tree/detail/timeline 的查询基础。

### 当前有效源码

- `server/src/services/task-action-service.ts`
- `server/src/services/task-actions/**`
- `server/src/services/task-creator-terminal-report-service.ts`
- `server/src/services/project-task-query-service.ts`
- `server/src/routes/project-task-routes.ts`
- `server/src/data/repository/project/repository-bundle.ts`
- `server/src/data/repository/project/taskboard-repository.ts`
- `server/src/data/repository/project/session-repository.ts`
- `server/src/data/repository/project/event-repository.ts`
- `server/src/data/repository/project/inbox-repository.ts`

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
- Creator terminal 汇总回执

### 不包含能力

- orchestrator dispatch/tick/reminder 策略
- manager message 主路由协议
- workflow runtime task-action 协议

## 3. 对外行为

### 写入口

- `POST /api/projects/:id/task-actions`

### 查询入口

- `GET /api/projects/:id/task-tree`
- `GET /api/projects/:id/tasks/:task_id/detail`

### 成功返回语义

- action 成功返回后，本次关键写入必须已经提交并对后续请求立即可见。
- 关键写入包含 taskboard、session 绑定、task-action 事件、路由所需 inbox/event。
- 不允许出现 “HTTP 201/200 成功，但下一条同项目请求看不到刚写入 task/dependency”。

### 输出契约

- action 响应字段保持：
  - `success`
  - `requestId`
  - `actionType`
  - `taskId`
  - `errorCode`
- `TASK_REPORT` 仅接受 `results[]`。
- `results[].outcome` 仅允许：
  - `IN_PROGRESS`
  - `BLOCKED_DEP`
  - `DONE`
  - `CANCELED`
- 退役字段持续硬切：
  - `report_mode`
  - `PARTIAL/BLOCKED/FAILED`（旧 outcome）

## 4. 内部逻辑

### 写入主链路

- route 只负责鉴权、参数解析、错误翻译与 service 调用。
- `task-action-service` 负责 action dispatch、写上下文与用例编排。
- action 处理收敛在：
  - `task-actions/assignment-processing.ts`
  - `task-actions/update-processing.ts`
  - `task-actions/discuss-processing.ts`
  - `task-actions/report-processing.ts`
- task-action 主链路通过 `ProjectRepositoryBundle` 访问数据，不允许直连内部 persistence。

### 事务与可见性约束

- 单次 task-action 的关键写入在同一 repository/UoW 边界内完成。
- 成功响应后，下一条同项目 action 的依赖校验必须立即可见前序写入。
- 提交失败、回滚失败、写后不可见都不得返回成功。

### 依赖合法性

- 禁止依赖 parent 或任意 ancestor。
- 新增并要求：若新依赖任务可经 dependency 链到达当前任务任一 ancestor（隐式祖先环），同样拒绝写入。
- 违规统一返回 `TASK_DEPENDENCY_ANCESTOR_FORBIDDEN`（409），不新增外部错误码。
- 错误 `details` 需包含命中 ancestor 与链路证据，便于 E2E 与日志定位。
- 依赖不存在、循环依赖、跨 root 依赖均视为硬失败，不允许成功吞错。

### TASK_REPORT 规则

- 上报资格：`owner_role == from_agent` 或 `creator_role == from_agent`。
- 依赖门禁是硬约束：
  - 依赖未满足时，禁止推进到 `IN_PROGRESS/DONE/MAY_BE_DONE`。
  - 允许上报 `BLOCKED_DEP`。
- 同批 `results[]` 按顺序评估，前序结果可影响后序状态预测。
- `DONE/CANCELED` 仅允许同状态幂等重复，不允许回退。

### progress 校验

- `DONE/BLOCKED_DEP` 仍要求有效 `progress.md` 证据。
- 证据不足返回 `TASK_PROGRESS_REQUIRED`。

## 5. 依赖关系

### 上游依赖

- `server/src/data/repository/project/repository-bundle.ts`
- `server/src/services/session-lifecycle-authority.ts`
- `server/src/services/routing-guard-service.ts`
- `server/src/services/orchestrator/shared/**`

### 下游影响

- project orchestrator runnable task 选择
- dashboard task tree/detail 展示
- project agent IO timeline

## 6. 约束条件

- project task protocol 是 project runtime 唯一主写入口。
- 退役接口保持 `410`：
  - `POST /api/projects/:id/agent-handoff`
  - `POST /api/projects/:id/reports`
  - `GET /api/projects/:id/tasks`
- 任务状态机保持：
  - `PLANNED`
  - `READY`
  - `DISPATCHED`
  - `IN_PROGRESS`
  - `BLOCKED_DEP`
  - `MAY_BE_DONE`
  - `DONE`
  - `CANCELED`

## 7. 异常与边界

| 场景                         | 错误码                               |
| ---------------------------- | ------------------------------------ |
| 祖先依赖非法（含隐式祖先环） | `TASK_DEPENDENCY_ANCESTOR_FORBIDDEN` |
| 路由越权                     | `TASK_ROUTE_DENIED`                  |
| 上报目标非法                 | `TASK_RESULT_INVALID_TARGET`         |
| 上报状态滞后                 | `TASK_STATE_STALE`                   |
| 依赖未满足推进上报           | `TASK_DEPENDENCY_NOT_READY`          |
| progress 证据不足            | `TASK_PROGRESS_REQUIRED`             |

## 8. 验证基线

- `server/src/__tests__/task-actions-api.test.ts`
- `server/src/__tests__/task-actions-durability.test.ts`
- `server/src/__tests__/task-report-owner-creator-partial.test.ts`
- `server/src/__tests__/task-dependency-ancestor-forbidden.test.ts`
- `pnpm --filter @autodev/server build`
- `pnpm --filter @autodev/server test`
