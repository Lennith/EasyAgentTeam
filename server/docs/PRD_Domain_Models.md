# 领域模型模块 PRD

## 1. 模块目标

### 模块职责
领域模型模块定义后端跨模块共享的数据契约，是存储层、服务层、API 层的统一类型基线。

**源码路径**:

- `server/src/domain/models.ts`

### 解决问题

- 统一任务、会话、消息、事件、锁等核心实体结构
- 固化 Task V2 协议字段与状态机枚举
- 降低跨模块字段漂移与语义冲突

### 业务价值

- 提升接口一致性和维护效率
- 为文档、测试、实现提供单一真源

---

## 2. 功能范围

### 包含能力

- Project / Task / Session / Event / Lock 模型
- TaskAction 请求与响应模型
- TaskTree / TaskDetail 查询模型
- Envelope 与 Accountability 消息模型

### 不包含能力

- 运行时业务校验逻辑
- 文件持久化读写逻辑

---

## 3. 对外行为

### 3.1 输入

- 无直接运行时输入（类型定义模块）

### 3.2 输出

- TypeScript 类型导出供 `data/**`、`services/**`、`app.ts` 共用

---

## 4. 内部逻辑

### 核心枚举

- `TaskState`：`PLANNED | READY | DISPATCHED | IN_PROGRESS | BLOCKED_DEP | MAY_BE_DONE | DONE | CANCELED`
- `TaskKind`：`PROJECT_ROOT | USER_ROOT | EXECUTION`
- `SessionStatus`：`running | idle | blocked | dismissed`
- `TaskActionType`：`TASK_CREATE | TASK_UPDATE | TASK_ASSIGN | TASK_DISCUSS_REQUEST | TASK_DISCUSS_REPLY | TASK_DISCUSS_CLOSED | TASK_REPORT`

### 核心结构

- `TaskRecord`：含 parent/root/creator/owner/dependencies/grantedAt/closedAt/closeReportId
- `SessionRecord`：含 `sessionId`、`sessionKey`、`providerSessionId`、`agentTool`、`agentPid`
- `TaskActionResult`：支持 `partialApplied`、`appliedTaskIds`、`rejectedResults`
- `TaskTreeNode`：含 `task_detail_id` 供前端跳转详情

---

## 5. 依赖关系

### 上游依赖

- 无

### 下游影响

- 所有 store/service/API 模块
- `agent_library` 之外的后端内部契约同步

---

## 6. 约束条件

- `schemaVersion` 当前统一为 `1.0`
- 时间字段统一 ISO 8601
- Task V2 写入与查询字段必须与此模型保持一致

---

## 7. 异常与边界

- 类型模块不直接抛业务异常
- 业务异常码由 service/store 层定义（如 `TASK_DEPENDENCY_ANCESTOR_FORBIDDEN`）

---

## 8. 数据定义

### 关键类型

- `ProjectRecord`
- `TaskRecord`
- `SessionRecord`
- `TaskActionRequest` / `TaskActionResult`
- `TaskTreeResponse`
- `TaskDetailResponse`
- `EventRecord`

### 关键语义

- `ownerRole`：执行责任角色
- `creatorRole`：任务创建角色
- `parentTaskId/rootTaskId`：任务树层级关系

---

## 9. 待确认问题

- `MAY_BE_DONE` 是否长期保留为状态机固定态。
- `SessionRecord.provider` 是否扩展为多 provider 显式枚举（当前固定 `codex` 语义字段）。
