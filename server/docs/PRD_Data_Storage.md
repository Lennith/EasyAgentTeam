# 数据存储模块 PRD

## 1. 模块目标

### 模块职责

数据存储模块负责后端运行数据的 JSON/JSONL 持久化与读取，是业务状态的落盘基础层。

**源码路径**:

- `server/src/data/**`

### 解决问题

- 为项目、任务、会话、事件、锁提供统一落盘能力
- 保证编排器与任务系统可恢复（重启后可继续）
- 提供带错误码的 store 级校验与异常返回

### 业务价值

- 提高系统可恢复性与可审计性
- 降低内存态与磁盘态不一致风险

---

## 2. 功能范围

### 包含能力

- 项目存储：`project-store.ts`
- 任务存储：`taskboard-store.ts`
- 会话存储：`session-store.ts`
- 事件存储：`event-store.ts`
- 消息收件箱：`inbox-store.ts`
- 锁存储：`lock-store.ts`
- 运行时配置：`runtime-settings-store.ts`
- 角色提醒：`role-reminder-store.ts`
- Agent/模板注册：`agent-store.ts` `agent-template-store.ts`

### 不包含能力

- 调度与业务编排决策
- 前端展示和聚合视图渲染

---

## 3. 对外行为

### 3.1 输入

- `dataRoot`
- `ProjectPaths`
- 各 store 的结构化输入（create/patch/query）

### 3.2 输出

- 结构化实体：`ProjectRecord`、`TaskRecord`、`SessionRecord` 等
- store 级错误码（例如 `TASK_NOT_FOUND`、`SESSION_ROLE_CONFLICT`）

---

## 4. 内部逻辑

### 核心处理规则

1. 文件不存在时按模块默认状态初始化。
2. 写入前统一做输入归一化与基础校验。
3. 事件写入采用 JSONL 追加模式。
4. task/session 等关键状态修改后同步 `updatedAt`。

### 目录布局（核心）

- `data/projects/<projectId>/project.json`
- `data/projects/<projectId>/collab/state/taskboard.json`
- `data/projects/<projectId>/collab/state/sessions.json`
- `data/projects/<projectId>/collab/state/role_reminders.json`
- `data/projects/<projectId>/collab/events.jsonl`
- `data/projects/<projectId>/collab/inbox/*.jsonl`
- `data/projects/<projectId>/collab/locks/*.json`

---

## 5. 依赖关系

### 上游依赖

- `node:fs/promises`
- `node:path`
- `file-utils.ts`

### 下游影响

- `services/**` 的所有业务能力
- API 层请求结果与错误码

---

## 6. 约束条件

- 主存储格式：JSON 与 JSONL
- `schemaVersion` 固定为 `1.0`
- id 字段需满足规范化校验（store 内实现）

---

## 7. 异常与边界

| 场景          | 处理                             |
| ------------- | -------------------------------- |
| 文件缺失      | 返回默认状态或按需初始化         |
| JSON 解析失败 | 抛 store 级错误，交由 API 层映射 |
| 并发更新冲突  | 通过原子写与流程约束降低风险     |

---

## 8. 数据定义

### 核心状态文件

- `TaskboardState`
- `SessionsState`
- `RoleRemindersState`
- `RuntimeSettings`

### 关键错误类型

- `ProjectStoreError`
- `TaskboardStoreError`
- `SessionStoreError`
- `LockStoreError`

---

## 9. 待确认问题

- 是否需要引入事件归档与分片策略（当前为单文件追加）。
- 是否增加任务与会话状态快照校验工具（离线校验）。
