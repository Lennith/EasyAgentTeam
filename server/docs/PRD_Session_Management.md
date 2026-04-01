# Session 管理模块 PRD

## 1. 模块目标

### 模块状态

- `验证中`

### 模块职责

Session 管理模块负责 role 会话生命周期与运行态修复，核心目标是保持单一 `sessionId` 通道：

- 创建、查询、更新、dismiss、repair
- role -> active session 解析与映射维护
- timeout / repair / force bootstrap 后的状态收敛
- process termination 与会话状态更新闭环

### 当前有效源码

- `server/src/services/orchestrator/project-session-runtime-service.ts`
- `server/src/services/orchestrator/project-session-runtime-timeout.ts`
- `server/src/services/orchestrator/project-session-runtime-termination.ts`
- `server/src/services/orchestrator/workflow-session-runtime-service.ts`
- `server/src/services/orchestrator/workflow-session-runtime-timeout.ts`
- `server/src/services/session-lifecycle-authority.ts`
- `server/src/routes/project-runtime-routes.ts`
- `server/src/routes/workflow-routes.ts`

## 2. 对外行为

### 2.1 Project

- `POST /api/projects/:id/sessions`
- `GET /api/projects/:id/sessions`
- `POST /api/projects/:id/sessions/:session_id/dismiss`
- `POST /api/projects/:id/sessions/:session_id/repair`

### 2.2 Workflow

- `GET /api/workflow-runs/:run_id/sessions`
- `POST /api/workflow-runs/:run_id/sessions`

### 2.3 输出约束

- API 对外统一使用 `sessionId`。
- 不恢复旧的 `sessionKey` 语义。
- `providerSessionId` 仅作为内部运行态字段，不作为外部主键。

## 3. 核心规则

### 3.1 创建与 role 槽位

1. 同 role 存在 active authoritative session 时，拒绝重复创建（冲突错误）。
2. force dispatch 下，允许对 owner role 进行按需 bootstrap。
3. bootstrap 成功后必须同步写入 role-session 映射与审计事件。

### 3.2 dismiss / repair / timeout

- dismiss：先终止运行进程，再写入 `dismissed`。
- repair：通过 application service 执行状态修复（`idle/blocked`），不在 route 层拼事务。
- timeout：先做 session/process 收口，再补 dispatch/run 闭环事件，再写 timeout 事件。

### 3.3 authoritative session

- 同 role 调度/路由时统一走 authoritative active session 解析，不允许并行漂移。
- role-session 映射写入必须经过 guard 校验。

## 4. 事务边界

- session 状态修改、事件追加、关联 runtime/task 修正必须放在同一 application service 事务边界。
- route 层只做 HTTP 解析、参数校验、响应映射，不直接开事务。

## 5. 约束条件

- `sessionId` 匹配 `^[a-zA-Z0-9._:-]+$`
- `status` 允许值：`running | idle | blocked | dismissed`
- `agentPid` 仅为运行辅助字段，不作为接口契约字段

## 6. 异常与边界

| 场景            | 错误码                           |
| --------------- | -------------------------------- |
| role 缺失       | `INVALID_ROLE`                   |
| status 非法     | `INVALID_STATUS`                 |
| role 槽位冲突   | `SESSION_ROLE_CONFLICT`          |
| session 不存在  | `SESSION_NOT_FOUND`              |
| provider 不支持 | `SESSION_PROVIDER_NOT_SUPPORTED` |

## 7. 验证基线（当前）

- `server/src/__tests__/session-dismiss-process-termination.test.ts`
- `server/src/__tests__/session-timeout-closure.test.ts`
- `server/src/__tests__/workflow-session-timeout-recovery.test.ts`
