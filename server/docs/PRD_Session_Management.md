# Session 管理模块 PRD

## 1. 模块目标

### 模块职责
Session 管理模块负责项目内角色会话生命周期与会话标识管理，覆盖：

- 会话创建、更新、查询、状态迁移
- pending session 到 provider session（codex session id）提升
- role -> session 映射维护
- dismiss / timeout / repair 的状态收敛配套

**源码路径**:

- `server/src/data/session-store.ts`
- `server/src/app.ts`（`/api/projects/:id/sessions*`）
- `server/src/services/orchestrator-service.ts`（dismiss/timeout 终止与 repair）

### 解决问题

- 角色视角的稳定会话槽位（避免多会话冲突）
- provider session id 在运行后回填并可继续复用
- 会话异常（卡住/超时）可自动或人工收敛

### 业务价值

- 保证编排器调度可持续、可恢复
- 降低“无会话可派发”或“会话僵死”的中断概率

---

## 2. 功能范围

### 包含能力

- `POST /api/projects/:id/sessions`
- `GET /api/projects/:id/sessions`
- `POST /api/projects/:id/sessions/:session_id/dismiss`
- `POST /api/projects/:id/sessions/:session_id/repair`
- session id / session key 双解析
- pending 会话提升（`promotePendingSessionToCodex`）

### 不包含能力

- 任务状态机与任务依赖判定（由 task 模块负责）
- 消息路由规则（由 routing 模块负责）

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
| session_id/sessionId | string | 否 | 外部请求 key（作为 `sessionKey`） |

#### 修复会话

`POST /api/projects/:id/sessions/:session_id/repair`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| target_status | `idle \| blocked` | 是 | 目标状态 |

### 3.2 输出

- 创建返回 pending 结构（`status: pending`，含 `sessionKey`）
- 列表返回 role 聚合后的最新会话（pending 时 `sessionId=null`）
- dismiss 返回：`session` + `processTermination` 结果

---

## 4. 内部逻辑

### 核心处理规则

#### 4.1 会话创建规则

1. 同 role 存在未 dismissed 会话时拒绝（`SESSION_ROLE_CONFLICT`）。
2. 创建 `pending-<role>-<suffix>` 形式的会话 id。
3. provider 固定为 `codex`（语义上作为 provider session 主键）。
4. `agentTool` 从项目 `agentModelConfigs` 读取（`codex/trae/minimax`）。

#### 4.2 pending 提升规则

- run 拿到真实 provider session id 后，`promotePendingSessionToCodex(...)` 原地提升：
  - `sessionId` 替换为真实 provider id
  - 保留 `sessionKey`
  - inbox 文件按 session id 重命名（若目标不存在）

#### 4.3 状态收敛规则

- `touchSession` 在状态非 `running` 时自动清空 `agentPid`。
- dismiss 先尝试进程终止，再置 `dismissed`。
- repair 允许人工恢复到 `idle/blocked`。

---

## 5. 依赖关系

### 上游依赖

- `file-utils`（JSON 文件读写）
- `project-store`（roleSessionMap 映射）

### 下游影响

- orchestrator 选取可调度会话
- routing 根据 role/session 解析消息目标

---

## 6. 约束条件

- `sessionId/sessionKey` 必须匹配 `^[a-zA-Z0-9._:-]+$`
- `status` 仅允许：`running/idle/blocked/dismissed`
- 同角色默认单活跃会话策略

---

## 7. 异常与边界

| 场景 | 错误码 |
|---|---|
| role 缺失 | `INVALID_ROLE` |
| status 非法 | `INVALID_STATUS` |
| 同 role 冲突 | `SESSION_ROLE_CONFLICT` |
| session 不存在 | `SESSION_NOT_FOUND` |
| provider 不支持 | `SESSION_PROVIDER_NOT_SUPPORTED` |

---

## 8. 数据定义

### 核心类型

- `SessionRecord`
- `SessionsState`
- `SessionStatus`

### 关键字段

- `sessionId`：当前主会话标识（提升后为 provider session id）
- `sessionKey`：pending/外部引用 key
- `providerSessionId`：provider 侧会话 id
- `agentPid`：运行进程 pid（仅 running 允许）

---

## 9. 待确认问题

- 是否将“同 role 单会话”策略改为项目可配置。
- 是否补充会话级审计聚合接口（当前以 events + timeline 组合查询）。
