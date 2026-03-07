# 领域模型模块 PRD

## 1. 模块目标

领域模型模块定义后端统一数据契约，是 `data/`、`services/`、`app.ts` 的共享类型基线。

源码：`server/src/domain/models.ts`

## 2. 范围

- Project / Task / Session / Event / Lock
- Task 协议输入输出
- TaskTree / TaskDetail 查询模型
- Workflow Template / Workflow Run / Workflow Runtime 模型

## 3. 核心枚举

### 3.1 Task 相关

- `TaskState`: `PLANNED | READY | DISPATCHED | IN_PROGRESS | BLOCKED_DEP | MAY_BE_DONE | DONE | CANCELED`
- `TaskKind`: `PROJECT_ROOT | USER_ROOT | EXECUTION`
- `TaskActionType`: `TASK_CREATE | TASK_UPDATE | TASK_ASSIGN | TASK_DISCUSS_REQUEST | TASK_DISCUSS_REPLY | TASK_DISCUSS_CLOSED | TASK_REPORT`

### 3.2 Session 相关

- `SessionStatus`: `running | idle | blocked | dismissed`

### 3.3 Workflow Runtime 相关

- `WorkflowRunState`: `created | running | stopped | finished | failed`
- `WorkflowStepState`: `CREATED | READY | BLOCKED_DEP | IN_PROGRESS | DONE | CANCELED | FAILED`
- `WorkflowStepOutcome`: `IN_PROGRESS | BLOCKED_DEP | DONE | CANCELED | FAILED`
- `WorkflowBlockReasonCode`: `DEP_UNSATISFIED | RUN_NOT_RUNNING | INVALID_TRANSITION | STEP_NOT_FOUND | STEP_ALREADY_TERMINAL`

## 4. 关键结构

### 4.1 SessionRecord

- `sessionId` 为唯一会话主键（外部/内部统一）
- `providerSessionId` 为 provider 侧会话引用（内部运行态）

### 4.2 TaskRecord

- 树结构：`taskKind / parentTaskId / rootTaskId`
- 责任归属：`creatorRole/creatorSessionId` 与 `ownerRole/ownerSession`
- 约束字段：`state / dependencies / writeSet / acceptance / artifacts`

### 4.3 WorkflowRunRecord

- 基础字段：`runId/templateId/status/workspaceBindingMode/workspacePath/boundProjectId`
- 运行态字段（可选）：`runtime`
  - `initializedAt`
  - `updatedAt`
  - `transitionSeq`
  - `steps[]: WorkflowStepRuntimeRecord`

### 4.4 WorkflowStepRuntimeRecord

- `taskId`
- `state`
- `blockedBy`
- `blockedReasons`
- `lastSummary`
- `lastTransitionAt`
- `transitionCount`
- `transitions[]`

## 5. 语义约束

1. `schemaVersion` 统一 `1.0`。
2. 时间字段统一 ISO-8601。
3. Workflow runtime 对旧 run 采用懒初始化兼容。
4. `TASK_REPORT` 与 `STEP_REPORT` 为不同协议域：
   - Task 协议面向 project taskboard
   - Step 协议面向 workflow runtime

## 6. 影响面

- `server/src/data/*` 读写层
- `server/src/services/*` 协议与编排层
- `server/src/app.ts` API 输入输出
- `dashboard-v2/src/types/index.ts` 前端契约映射
