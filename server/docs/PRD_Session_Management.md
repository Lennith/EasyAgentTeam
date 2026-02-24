# Session 管理模块 PRD

## 1. 模块目标

### 模块职责
Session 管理模块负责项目内角色会话生命周期与角色会话槽位维护，核心是单 `sessionId` 通道：

- 会话创建、更新、查询、状态迁移
- `role -> sessionId` 映射维护
- dismiss / timeout / repair 的状态收敛
- `providerSessionId` 仅内部运行态字段，不作为外部主键

**源码路径**:

- `server/src/data/session-store.ts`
- `server/src/app.ts`（`/api/projects/:id/sessions*`）
- `server/src/services/orchestrator-service.ts`

### 解决问题

- 统一外部与内部会话标识，消除 `sessionId/sessionKey` 双语义
- 保证角色视角单活跃会话槽位
- 会话异常可自动或人工收敛

---

## 2. 功能范围

### 包含能力

- `POST /api/projects/:id/sessions`
- `GET /api/projects/:id/sessions`
- `POST /api/projects/:id/sessions/:session_id/dismiss`
- `POST /api/projects/:id/sessions/:session_id/repair`

### 不包含能力

- 任务依赖门禁与状态推进（task 模块）
- 消息路由策略判定（routing 模块）

---

## 3. 对外行为

### 3.1 输入

#### 创建会话

`POST /api/projects/:id/sessions`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| role | string | 是 | 角色名 |
| status | string | 否 | 初始状态，默认 `idle` |
| current_task_id | string | 否 | 当前任务 |

#### 修复会话

`POST /api/projects/:id/sessions/:session_id/repair`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| target_status | `idle \| blocked` | 是 | 目标状态 |

### 3.2 输出

- 创建返回 `session.sessionId`（始终为 string），并附 `status: "pending"`
- 列表按 role 聚合最新会话，`sessionId` 始终非空
- dismiss 返回 `session` + `processTermination`
- 不再对外返回 `sessionKey`
- 不再在 sessions API 对外返回 `providerSessionId`

---

## 4. 内部逻辑

### 核心处理规则

#### 4.1 会话创建规则

1. 同 role 存在未 dismissed 会话时拒绝（`SESSION_ROLE_CONFLICT`）。
2. 自动生成 `pending-<role>-<suffix>` 形式的 `sessionId`。
3. `agentTool` 从项目 `agentModelConfigs` 读取（`codex/trae/minimax`）。

#### 4.2 运行态字段规则

- `providerSessionId` 仅用于运行器内部 resume 语义。
- 该字段不作为 API 主键，不参与会话查找。

#### 4.3 状态收敛规则

- `touchSession` 在状态非 `running` 时自动清空 `agentPid`。
- dismiss：先尝试进程终止，再置 `dismissed`。
- repair：人工恢复为 `idle/blocked`。

---

## 5. 约束条件

- `sessionId` 必须匹配 `^[a-zA-Z0-9._:-]+$`
- `status` 仅允许 `running/idle/blocked/dismissed`
- 默认同 role 单活跃会话策略

---

## 6. 异常与边界

| 场景 | 错误码 |
|---|---|
| role 缺失 | `INVALID_ROLE` |
| status 非法 | `INVALID_STATUS` |
| 同 role 冲突 | `SESSION_ROLE_CONFLICT` |
| session 不存在 | `SESSION_NOT_FOUND` |
| provider 不支持 | `SESSION_PROVIDER_NOT_SUPPORTED` |

---

## 7. 数据定义

### 核心类型

- `SessionRecord`
- `SessionsState`
- `SessionStatus`

### 关键字段

- `sessionId`：唯一会话主键（对内对外一致）
- `providerSessionId`：内部运行态字段（resume 语义）
- `agentPid`：运行进程 pid（仅 `running` 保留）
