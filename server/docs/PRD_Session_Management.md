# Session 管理模块 PRD

## 模块状态

- `实装`

## 1. 模块目标

### 模块职责

Session 管理模块负责项目内角色会话生命周期与角色会话槽位维护，核心是统一 `sessionId` 通道：

- 会话创建、查询、更新、dismiss、repair
- `role -> sessionId` 映射维护
- timeout / repair / force bootstrap 后的状态收敛
- `providerSessionId` 仅作为运行态字段，不作为外部主键

**源码路径**:

- `server/src/data/session-store.ts`
- `server/src/services/orchestrator/project-session-runtime-service.ts`
- `server/src/services/orchestrator/project-session-runtime-timeout.ts`
- `server/src/services/orchestrator/project-session-runtime-termination.ts`
- `server/src/services/orchestrator/workflow-session-runtime-service.ts`
- `server/src/services/orchestrator/workflow-session-runtime-timeout.ts`
- `server/src/routes/project-runtime-routes.ts`
- `server/src/services/orchestrator/project-dispatch-service.ts`

### 当前收敛目标

- 会话运行态副作用统一由 application service 协调
- route 不直接承担 session 恢复事务边界
- API 继续只暴露 `sessionId`，不恢复 `sessionKey`

---

## 2. 功能范围

### 包含能力

- `POST /api/projects/:id/sessions`
- `GET /api/projects/:id/sessions`
- `POST /api/projects/:id/sessions/:session_id/dismiss`
- `POST /api/projects/:id/sessions/:session_id/repair`
- force dispatch 时按需 bootstrap owner session

### 不包含能力

- task 状态机推进
- message 路由策略判定

---

## 3. 对外行为

### 3.1 输入

#### 创建会话

`POST /api/projects/:id/sessions`

| 参数            | 类型   | 必填 | 说明                  |
| --------------- | ------ | ---- | --------------------- |
| role            | string | 是   | 角色名                |
| status          | string | 否   | 初始状态，默认 `idle` |
| current_task_id | string | 否   | 当前任务              |

#### 修复会话

`POST /api/projects/:id/sessions/:session_id/repair`

| 参数          | 类型              | 必填 | 说明     |
| ------------- | ----------------- | ---- | -------- |
| target_status | `idle \| blocked` | 是   | 目标状态 |

### 3.2 输出

- 创建返回 `session.sessionId`，并保持 string 类型
- 列表按 role 聚合 authoritative active session
- dismiss 返回 `session` + `processTermination`
- 不再对外返回 `sessionKey`
- 不在 sessions API 对外返回 `providerSessionId`

---

## 4. 内部逻辑

### 4.1 创建规则

1. 同 role 存在 active session 时拒绝创建，返回 `SESSION_ROLE_CONFLICT`
2. force dispatch 可在 owner role 无 authoritative active session 时自动 bootstrap session
3. bootstrap 出来的 session 仍需写入 role-session mapping 与审计事件

### 4.2 状态收敛规则

- dismiss：先终止进程，再写 `dismissed`
- repair：通过 application service 写回 `idle/blocked`
- timeout：先做进程终止，再补 dispatch/run 闭环事件，再落 `SESSION_HEARTBEAT_TIMEOUT`
- `agentPid` 仅作为运行态辅助字段，不作为 API 主键

### 4.3 事务边界

- session 状态修改、事件追加、相关 task/runtime 修正必须在同一 application service 事务中完成
- route 层不得直接开启事务

---

## 5. 约束条件

- `sessionId` 必须匹配 `^[a-zA-Z0-9._:-]+$`
- `status` 仅允许 `running/idle/blocked/dismissed`
- 同 role 默认单 authoritative active session

---

## 6. 异常与边界

| 场景            | 错误码                           |
| --------------- | -------------------------------- |
| role 缺失       | `INVALID_ROLE`                   |
| status 非法     | `INVALID_STATUS`                 |
| 同 role 冲突    | `SESSION_ROLE_CONFLICT`          |
| session 不存在  | `SESSION_NOT_FOUND`              |
| provider 不支持 | `SESSION_PROVIDER_NOT_SUPPORTED` |

---

## 7. 数据定义

### 核心类型

- `SessionRecord`
- `SessionsState`
- `SessionStatus`

### 关键字段

- `sessionId`：唯一会话主键
- `providerSessionId`：内部运行态字段
- `agentPid`：运行进程 pid，仅在运行态保留
- `lastRunId` / `lastDispatchId`：编排闭环恢复辅助字段
