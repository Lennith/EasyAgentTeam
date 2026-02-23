# 路由与消息编排模块 PRD

## 1. 模块目标

### 模块职责
路由与消息编排模块负责管理 agent 间通信目标解析、路由授权、会话映射与消息投递。

**源码路径**:

- `server/src/services/manager-message-service.ts`
- `server/src/services/routing-guard-service.ts`
- `server/src/services/project-routing-snapshot-service.ts`
- `server/src/services/manager-routing-service.ts`

### 解决问题

- 消息“发给谁”与“发到哪个 session”的一致性
- 路由表约束下的越权拦截
- pending session 启动与 role->session 映射修复

### 业务价值

- 保证通信链路可控、可审计
- 让自动编排可依赖稳定路由快照

---

## 2. 功能范围

### 包含能力

- `/messages/send` 的统一处理（仅 CHAT + discuss）
- 路由授权校验（项目 route_table）
- 显式 session 目标校验（保留 session 保护）
- role 映射 session 自动解析与自动建会话
- 路由快照构建（前端/工具查询）

### 不包含能力

- task 创建/分配/上报（由 task-actions 处理）
- runner 调度（由 orchestrator 处理）

---

## 3. 对外行为

### 3.1 输入

#### 来源

- API：`POST /api/projects/:id/messages/send`
- Team Tool Bridge：`sendMessage(...)`

#### message_type

- `MANAGER_MESSAGE`
- `TASK_DISCUSS_REQUEST`
- `TASK_DISCUSS_REPLY`
- `TASK_DISCUSS_CLOSED`

### 3.2 输出

- `requestId/messageId/resolvedSessionId/messageType`
- 事件：`USER_MESSAGE_RECEIVED`、`MESSAGE_ROUTED`、`MESSAGE_ROUTE_DENIED`

---

## 4. 内部逻辑

### 核心处理规则

1. 先做协议校验：拒绝 `mode=TASK_ASSIGN`（已退役）。
2. 校验 `message_type` 与内容编码（含乱码检测）。
3. 解析目标：`to.session_id` 优先，其次 `to.agent(role)`。
4. 若目标 role 无活跃会话，自动创建 pending session。
5. 路由授权不通过时拒绝并记事件。
6. 成功投递后写入 routed/user_message 事件。

### 路由保护

- 禁止向保留 session（如系统保留 id）直接写入。
- role-session map 写入需通过守卫校验。

---

## 5. 依赖关系

### 上游依赖

- `project-store`（route_table, role_session_map）
- `session-store`（会话解析与创建）
- `event-store`（审计事件）

### 下游影响

- inbox 消息进入后由 orchestrator 继续调度

---

## 6. 约束条件

- 默认路由旁路角色：`manager/user/system/dashboard`。
- 普通 agent 严格按 route_table 授权。
- 目标 session 解析失败时必须返回可行动错误提示。

---

## 7. 异常与边界

| 场景 | 错误码 |
|---|---|
| message_type 非法 | `MESSAGE_TYPE_INVALID` |
| 目标缺失 | `MESSAGE_TARGET_REQUIRED` |
| 内容编码疑似损坏 | `MESSAGE_ENCODING_INVALID` |
| 路由不允许 | `MESSAGE_ROUTE_DENIED` |
| 旧语义调用 | `ENDPOINT_RETIRED` |

---

## 8. 数据定义

### 关键字段

- `toRole`：目标角色
- `resolvedSessionId`：最终投递 session
- `taskId`：可选任务绑定（discuss 场景）

### 关键事件

- `USER_MESSAGE_RECEIVED`
- `MESSAGE_ROUTED`
- `MESSAGE_ROUTE_DENIED`

---

## 9. 待确认问题

- 是否需要将乱码检测阈值项目化配置。
- 是否增加“消息重试策略”事件分级。
