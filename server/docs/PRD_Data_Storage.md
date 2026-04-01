# 数据存储模块 PRD

## 1. 模块目标

### 模块状态

- `改动中`

### 本轮收敛约束（2026-03-29）

- 继续扩展既有 `ProjectRepositoryBundle` 覆盖面，不新增新的 shared contract 概念。
- 路由权限判定与 role-session 映射写入优先通过 `projectRuntime` repository seam 暴露。

### 模块职责

数据存储模块负责后端运行数据的持久化与事务边界承载，覆盖：

- project / workflow 文档型状态读写（JSON）
- event / inbox 日志型追加写（JSONL）
- repository + UnitOfWork 抽象
- file backend 与 memory backend 一致语义

### 当前有效源码

- 共享抽象：
  - `server/src/data/repository/types.ts`
  - `server/src/data/repository/runtime.ts`
- Project repository：
  - `project-repository-bundle.ts`
  - `project-runtime-repository.ts`
  - `taskboard-repository.ts`
  - `session-repository.ts`
  - `event-repository.ts`
  - `inbox-repository.ts`
- Workflow repository：
  - `workflow-repository-bundle.ts`
  - `workflow-run-repository.ts`
  - `workflow-session-repository.ts`
  - `workflow-event-repository.ts`
  - `workflow-inbox-repository.ts`
  - `workflow-reminder-repository.ts`

## 2. 数据边界与原则

1. route 层不直接开启事务。
2. application service 是 `UnitOfWork.run(...)` 的拥有者。
3. service 必须通过 repository bundle 访问主链路数据，不绕过 repository 直连 file util。
4. 文档型状态保持 JSON；事件与 inbox 保持 JSONL，不强行混成一套过宽接口。
5. role reminder 状态保持落在 runtime 文档：
   - project：project runtime 文档
   - workflow：workflow reminder/runtime 文档

## 3. 统一 scope contract（当前有效）

Project / Workflow repository bundle 都统一提供：

- `resolveScope(scopeId)`
- `runInUnitOfWork(scope, operation)`
- `runWithResolvedScope(scopeId, operation)`

编排 shared contract 仅依赖这组统一 seam，不再依赖历史分叉命名。

## 4. 主链路入口

### 4.1 Project

- `ProjectRepositoryBundle`
  - `projectRuntime`
  - `taskboard`
  - `sessions`
  - `events`
  - `inbox`

### 4.2 Workflow

- `WorkflowRepositoryBundle`
  - `workflowRuns`
  - `sessions`
  - `events`
  - `inbox`
  - `reminders`

## 5. 事务语义（硬约束）

- 同一用例内的关键写入必须处于同一 UoW 边界，尤其是：
  - taskboard
  - runtime
  - sessions
  - events
  - inbox
- callback 抛错时：
  - file backend 回滚 staged writes
  - memory backend 提供等价事务语义用于测试

## 6. 目录布局（当前有效）

### 6.1 Project

- `data/projects/<projectId>/project.json`
- `data/projects/<projectId>/collab/state/taskboard.json`
- `data/projects/<projectId>/collab/state/sessions.json`
- `data/projects/<projectId>/collab/state/role-reminders.json`
- `data/projects/<projectId>/collab/events.jsonl`
- `data/projects/<projectId>/collab/inbox/*.jsonl`

### 6.2 Workflow

- `data/workflows/templates/<templateId>.json`
- `data/workflows/runs/<runId>/run.json`
- `data/workflows/runs/<runId>/task-runtime.json`
- `data/workflows/runs/<runId>/sessions.json`
- `data/workflows/runs/<runId>/events.jsonl`
- `data/workflows/runs/<runId>/inbox/<role>.jsonl`
- `data/workflows/runs/<runId>/role-reminders.json`

## 7. 异常与边界

| 场景                | 处理                                      |
| ------------------- | ----------------------------------------- |
| 文件不存在          | 返回默认状态或按需初始化                  |
| JSON/JSONL 解析失败 | 抛数据层错误，不伪装业务成功              |
| 事务回调抛错        | UoW 回滚                                  |
| scope 不存在        | repository 返回空，由上层决定业务错误映射 |

## 8. 验证基线（当前）

- `server/src/__tests__/repository-runtime.test.ts`
- `server/src/__tests__/project-repository-bundle.test.ts`
- `server/src/__tests__/workflow-repository-bundle.test.ts`
- `pnpm --filter @autodev/server build`
- `pnpm --filter @autodev/server test`
