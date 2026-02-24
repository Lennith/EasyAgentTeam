# 领域模型模块 PRD

## 1. 模块目标

领域模型模块定义后端统一数据契约，是 `data/services/app` 的共享类型基线。  
源码：`server/src/domain/models.ts`

---

## 2. 核心范围

- Project / Task / Session / Event / Lock 模型
- TaskAction 输入输出模型
- TaskTree / TaskDetail 查询模型
- Envelope / Accountability 消息模型

---

## 3. 关键枚举

- `TaskState`  
  `PLANNED | READY | DISPATCHED | IN_PROGRESS | BLOCKED_DEP | MAY_BE_DONE | DONE | CANCELED`
- `TaskKind`  
  `PROJECT_ROOT | USER_ROOT | EXECUTION`
- `SessionStatus`  
  `running | idle | blocked | dismissed`
- `TaskActionType`  
  `TASK_CREATE | TASK_UPDATE | TASK_ASSIGN | TASK_DISCUSS_REQUEST | TASK_DISCUSS_REPLY | TASK_DISCUSS_CLOSED | TASK_REPORT`

---

## 4. 关键结构

### 4.1 SessionRecord

- `sessionId`：唯一会话主键（对内对外一致）
- `providerSessionId?`：内部运行态字段（resume 语义）
- `agentTool` / `agentPid`：执行信息

> 说明：`sessionKey` 已退役，不再属于模型。

### 4.2 RoleReminderState

- `role`
- `idleSince`
- `reminderCount`
- `nextReminderAt`
- `lastRoleState`

> 说明：`lastSessionId` 已退役，提醒逻辑不再耦合具体 session。

### 4.3 TaskRecord

- 树结构：`taskKind / parentTaskId / rootTaskId`
- 责任字段：`creatorRole/creatorSessionId`、`ownerRole/ownerSession`
- 状态与约束：`state / dependencies / writeSet / acceptance / artifacts`

### 4.4 TaskReport

- `results[].outcome` 与状态语义同构：  
  `IN_PROGRESS | BLOCKED_DEP | DONE | CANCELED`

---

## 5. 语义约束

- `schemaVersion` 统一 `1.0`
- 时间字段统一 ISO-8601
- TaskAction 与 TaskTree 输出字段必须与模型一致

---

## 6. 影响面

- `session-store`、`orchestrator-service`、`app.ts` 会话接口
- `task-action-service` 报告与事件语义
- dashboard API 对接与时间线展示
