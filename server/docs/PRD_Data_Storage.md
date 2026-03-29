# 数据存储模块 PRD

## 1. 模块目标

### 模块状态

- `实装`

### 模块职责

数据存储模块负责后端运行时数据的持久化、读取与事务边界承载，覆盖：

- project / workflow 文档型 JSON 存储
- taskboard / session / runtime / reminder 状态存储
- event / inbox 的 JSONL 追加写入
- repository + UnitOfWork 抽象
- file backend 与 memory backend 的统一语义

### 解决问题

- 让 project 主链路与 workflow 主链路都通过 repository/UoW 收口事务边界
- 避免 route 或 service 直接散落调用底层文件工具，造成写入旁路
- 保持 file backend 与 memory backend 在测试和运行时行为一致

### 主要源码

- `server/src/data/repository/types.ts`
- `server/src/data/repository/runtime.ts`
- `server/src/data/repository/project-repository-bundle.ts`
- `server/src/data/repository/project-runtime-repository.ts`
- `server/src/data/repository/taskboard-repository.ts`
- `server/src/data/repository/session-repository.ts`
- `server/src/data/repository/event-repository.ts`
- `server/src/data/repository/inbox-repository.ts`
- `server/src/data/repository/workflow-repository-bundle.ts`
- `server/src/data/repository/workflow-run-repository.ts`
- `server/src/data/repository/workflow-session-repository.ts`
- `server/src/data/repository/workflow-event-repository.ts`
- `server/src/data/repository/workflow-inbox-repository.ts`
- `server/src/data/repository/workflow-reminder-repository.ts`
- `server/src/data/project-store.ts`
- `server/src/data/taskboard-store.ts`
- `server/src/data/session-store.ts`
- `server/src/data/event-store.ts`
- `server/src/data/inbox-store.ts`
- `server/src/data/workflow-store.ts`
- `server/src/data/workflow-run-store.ts`

---

## 2. 功能范围

### 包含能力

- project 元数据存储
- taskboard 状态存储
- session 状态存储
- event 事件日志存储
- inbox 消息存储
- workflow run / runtime / role reminder 存储
- repository 工厂与 bundle 聚合
- UnitOfWork 事务包装

### 不包含能力

- HTTP 参数校验与响应映射
- 编排决策、状态机与调度策略
- 业务级错误提示文案

---

## 3. 数据边界

### 统一原则

1. route 层不持有事务，不直接调用 `runStorageTransaction`
2. application service 持有 `UnitOfWork.run(...)`
3. service 通过 repository bundle 访问主链路数据，不绕过 repository 直接操作文件
4. 文档型状态继续使用 JSON；事件与 inbox 继续使用 JSONL
5. role reminder 状态继续落在 workflow/project runtime 文档，不新增独立 reminder store

### Project 主链路入口

- `ProjectRepositoryBundle`
  - `projectRuntime`
  - `taskboard`
  - `sessions`
  - `events`
  - `inbox`

### Workflow 主链路入口

- `WorkflowRepositoryBundle`
  - `workflowRuns`
  - `sessions`
  - `events`
  - `inbox`
  - `reminders`

### Shared Repository Scope Contract

- V3 hard cut 后，project / workflow bundle 只保留统一的 scope 方法，不再暴露旧的专有命名兼容入口
- 两条主链路统一通过以下方法暴露 scope seam：
  - `resolveScope(scopeId)`
  - `runInUnitOfWork(scope, operation)`
  - `runWithResolvedScope(scopeId, operation)`
- shared orchestrator contract 只依赖这组统一 seam，不直接耦合 project/workflow 的命名差异

---

## 4. 目录布局

### Project

- `data/projects/<projectId>/project.json`
- `data/projects/<projectId>/collab/state/taskboard.json`
- `data/projects/<projectId>/collab/state/sessions.json`
- `data/projects/<projectId>/collab/state/role-reminders.json`
- `data/projects/<projectId>/collab/events.jsonl`
- `data/projects/<projectId>/collab/inbox/*.jsonl`
- `data/projects/<projectId>/collab/locks/*.json`

### Workflow

- `data/workflows/templates/<templateId>.json`
- `data/workflows/runs/<runId>/run.json`
- `data/workflows/runs/<runId>/task-runtime.json`
- `data/workflows/runs/<runId>/sessions.json`
- `data/workflows/runs/<runId>/events.jsonl`
- `data/workflows/runs/<runId>/inbox/<role>.jsonl`
- `data/workflows/runs/<runId>/role-reminders.json`

---

## 5. 后端语义

### Repository 约束

- repository 只负责读写与最小归一化，不承载业务决策
- store error 与 repository error 保持数据层命名，不向上层泄漏 HTTP 语义
- bundle 负责聚合同一链路需要的 repository，但不承载状态机逻辑

### UnitOfWork 约束

- 同一用例中的 taskboard/session/event/inbox/runtime 写入必须放在同一 UoW 边界
- callback 抛错时，file backend 必须回滚 staged writes
- memory backend 必须提供等价事务语义用于测试

---

## 6. 异常与边界

| 场景                      | 处理                                          |
| ------------------------- | --------------------------------------------- |
| 文件缺失                  | 返回默认状态或按需初始化                      |
| JSON/JSONL 解析失败       | 抛数据层错误，不伪装成业务成功                |
| 事务回调抛错              | UnitOfWork 回滚已暂存写入                     |
| workflow / project 不存在 | repository 返回空值，由上层决定是否转业务错误 |

---

## 7. 当前测试覆盖

- `server/src/__tests__/repository-runtime.test.ts`
- `server/src/__tests__/project-repository-bundle.test.ts`
- `server/src/__tests__/workflow-repository-bundle.test.ts`
- `server/src/__tests__/workflow-runtime-kernel.test.ts`
- `server/src/__tests__/project-session-runtime-service.test.ts`
- `server/src/__tests__/project-reminder-service.test.ts`

---

## 8. 当前有效结论

- project 主链路已通过 `ProjectRepositoryBundle` 收口
- workflow 主链路已通过 `WorkflowRepositoryBundle` 收口到 run/session/event/inbox/reminder
- 两条 bundle 现在只保留统一的 shared repository scope seam：`resolveScope` / `runInUnitOfWork` / `runWithResolvedScope`
- route 层默认不再直接开事务
- workflow dispatch / reminder / session runtime 等 application service 已改为 repository-backed 读写
