# 路由与消息编排模块 PRD

## 1. 模块目标

### 模块状态

- `改动中`

### 模块职责

路由与消息编排模块负责 manager/agent 消息目标解析、路由授权、会话触达和事件落盘，目标是统一执行骨架并保留域策略差异。

### 当前有效源码

- `server/src/services/manager-message-service.ts`
- `server/src/services/manager-routing-event-service.ts`
- `server/src/services/routing-guard-service.ts`
- `server/src/services/project-routing-snapshot-service.ts`
- `server/src/services/orchestrator/project-message-routing-service.ts`
- `server/src/services/orchestrator/workflow-message-routing-service.ts`
- `server/src/services/orchestrator/shared/message-routing-template.ts`
- `server/src/services/orchestrator/shared/manager-message-contract.ts`

## 2. 对外行为

### 2.1 Project

- `POST /api/projects/:id/messages/send`

### 2.2 Workflow

- `POST /api/workflow-runs/:run_id/messages/send`

### 2.3 message_type

- `MANAGER_MESSAGE`
- `TASK_DISCUSS_REQUEST`
- `TASK_DISCUSS_REPLY`
- `TASK_DISCUSS_CLOSED`

### 2.4 输出契约

- 返回 `requestId/messageId/resolvedSessionId/messageType`
- 保持事件链：
  - `USER_MESSAGE_RECEIVED`
  - `MESSAGE_ROUTED`

## 3. 当前执行骨架

两条链路统一走 `shared/message-routing-template.ts` 固定顺序：

1. `resolveTarget`
2. `normalizeEnvelope`
3. `persistInbox`
4. `persistRouteEvent`
5. `touchSession`
6. `buildResult`

可选：`runInUnitOfWork` 由 domain service 注入。

Project 侧 `routeProjectManagerMessage` 与 `routeProjectTaskAssignmentMessage` 已收敛到同一内部执行骨架（同一 template 调用路径），差异仅保留在 adapter 回调（inbox/event/result shaping）。
Project 侧 `deliverProjectMessage` 也已切入同一 template 路径，当前 manager message 的 `deliver/route/task-assignment-route` 三条主路径都通过 `executeOrchestratorMessageRouting(...)` 执行。

## 4. 域策略边界

### 4.1 Project 特有

- route_table 与 role-session map 约束
- reserved target session 拦截
- discuss message 与 taskboard 解析协同
- role 映射写入拒绝时补 `ROLE_SESSION_MAPPING_REJECTED`

### 4.2 Workflow 特有

- workflow route permission 校验
- authoritative session resolve（按 run 角色）
- workflow message payload contract（compact payload）

## 5. 约束与错误

| 场景                       | 错误码                    |
| -------------------------- | ------------------------- |
| message_type 非法          | `MESSAGE_TYPE_INVALID`    |
| 目标缺失                   | `MESSAGE_TARGET_REQUIRED` |
| 显式目标 session 非法/保留 | `MESSAGE_TARGET_INVALID`  |
| route 不允许               | `MESSAGE_ROUTE_DENIED`    |
| 旧语义调用                 | `ENDPOINT_RETIRED`        |

## 6. 稳定约束

- project/workflow 的外部 path、payload、status code 不变。
- route event payload 字段语义不变。
- 不回滚退役接口语义。

## 7. 当前收口计划（有效）

- 继续把 project/workflow 的 target resolve 与 session-touch 细节上提 shared seam。
- 保持“共享骨架 + 双 adapter”，不强行合并为单一大类。
- 本轮只做“现有骨架内收敛”，不新增 shared contract 名词体系。
- project 路由权限与 role-session 映射相关写入，优先走 repository seam，不再扩散直连 store 调用。
- 已落地（2026-03-29，实装）：`manager-message-service` 与 `task-actions` 的 project 路由权限判定改由 `projectRuntime` repository seam 统一提供。
- 已落地（2026-03-29，实装）：`manager-message-service` 的 role 目标会话解析收敛到既有 `resolveTargetSession(...)`，与 task-action 链路复用同一解析规则。
- 已落地（2026-03-29，实装）：`project-message-routing-service` 删除本地执行包装层，`routeProjectManagerMessage`、`routeProjectTaskAssignmentMessage`、`deliverProjectMessage` 统一直接走 shared message-routing template。
- 已落地（2026-03-29，实装）：新增 `project-message-routing-service.test.ts` 覆盖 manager-route 与 deliver bootstrap 合约，确保 route event 与 session bootstrap 语义稳定。
- 已落地（2026-03-29，实装）：project routing 内部的 target resolve/context 构建与 discuss message 解析已收敛到单 helper，减少 manager-route/task-assignment/deliver 三条路径的重复 role/taskboard 读取逻辑。
  > 2026-03-29 Round Continue #3（实装）
  >
  > - manager-route 与 task-assignment-route 公共执行骨架已收口到同一内部 helper：
  >   - `executeProjectRouteMessage(...)`
  > - Project routing 读路径收窄：
  >   - session/task 读取走 routing context cache
  > - 对外行为不变：
  >   - API path/payload/status/event type 全冻结
  > - 验证：
  >   - `pnpm --filter @autodev/server build` 通过
  >   - `pnpm --filter @autodev/server test` 通过

## 8. 2026-03-30 当前实装快照

- 状态：`实装`（本轮路由内聚重排已落地，外部协议冻结不变）。
- Project routing 结构收敛为薄 façade + internal helper：
  - `server/src/services/orchestrator/project-message-routing-service.ts`
    - 仅保留对外入口：
      - `deliverProjectMessage`
      - `routeProjectManagerMessage`
      - `routeProjectTaskAssignmentMessage`
  - `server/src/services/orchestrator/project-message-routing-internal.ts`
    - 负责 context/target resolve、session touch、role-session map、UoW 执行骨架
  - `server/src/services/orchestrator/project-message-routing-contracts.ts`
    - 负责 routing 内部类型契约（非 shared contract family 扩张）
- 执行骨架保持：
  - 仍统一走 `shared/message-routing-template.ts` 的执行顺序语义。
- 兼容性：
  - API path/payload/status code 不变
  - event type 与 payload 语义不变
- 验证：
  - `pnpm --filter @autodev/server build` 通过（2026-03-30）
  - `pnpm --filter @autodev/server run test -- --test-name-pattern "project-message-routing-service"` 通过
  - `pnpm --filter @autodev/server run test -- --test-name-pattern "task-actions-api"` 通过
