# 数据存储模块 PRD

## 1. 模块目标

### 模块状态

- `实装`

### 模块职责

数据存储模块负责 backend runtime 的持久化、repository/UoW 边界、WAL 恢复与提交一致性。

### 当前有效源码

- `server/src/data/repository/**`
- `server/src/data/internal/persistence/**`
- `server/src/services/project-admin-service.ts`
- `server/src/services/project-runtime-api-service.ts`
- `server/src/services/workflow-admin-service.ts`

## 2. 当前有效结构

### 唯一公开数据 seam

- `server/src/data/repository/project/**`
- `server/src/data/repository/workflow/**`
- `server/src/data/repository/catalog/**`
- `server/src/data/repository/system/**`
- `server/src/data/repository/shared/**`

### 内部持久化实现

- `server/src/data/internal/persistence/**`

### 边界规则

- route 不得直接持有事务边界。
- application service 通过 repository 或 repository bundle 访问数据。
- `internal/persistence` 只承载存储机制，不承载业务决策。
- 顶层 `data/*-store.ts` 已退役，不再作为公开 seam。

## 3. 主链路 contract

### Project

- `ProjectRepositoryBundle`
  - `projectRuntime`
  - `taskboard`
  - `sessions`
  - `events`
  - `inbox`

### Workflow

- `WorkflowRepositoryBundle`
  - `workflowRuns`
  - `sessions`
  - `events`
  - `inbox`
  - `reminders`

### 统一 scope/UoW 入口

- `resolveScope(scopeId)`
- `runInUnitOfWork(scope, operation)`
- `runWithResolvedScope(scopeId, operation)`

## 4. 事务与 durability 规则

- 同一用例内的关键写入必须处于同一 UoW 边界，尤其是：
  - runtime
  - taskboard
  - sessions
  - events
  - inbox
- file backend 与 memory backend 都必须提供等价提交语义。
- callback 抛错时必须回滚 staged writes，不能返回伪成功。
- 成功返回的写入必须对下一条同 scope 请求立即可见。

## 5. Project 删除与 runtime drain 规则

- `DELETE /api/projects/:id` 删除 project 目录前，必须先 drain 当前 project 的 runtime。
- drain 至少覆盖：
  - active session provider runtime
  - 仍在运行或仍可取消的 dispatch runner
  - 已注册但未完成清理的 callback/run 句柄
- 若 runtime 在超时窗口内未退出，删除必须失败，不允许直接硬删目录后让旧 runner 继续写回已复用的 project 路径。
- 目标是防止出现：
  - API 成功但 taskboard/session 写入未稳定落盘
  - 旧 project runner 在 project 复用后继续写 WAL / heartbeat
  - WAL 文件竞争导致 `EPERM`、脏可见性或 success-without-durability

## 6. WAL 与恢复规则

- server 启动时继续对已发现的 `.storage-wal` 根执行 recovery + committed cleanup。
- runtime 删除/复用路径的前提是：
  - 相关 provider/session 已经退出或被显式终止
  - 不再存在会继续写入该 project scope 的活跃回调
- WAL 清理不能替代 runtime drain；它只负责提交后的恢复与收尾。

## 7. 目录布局

### Project

- `data/projects/<projectId>/project.json`
- `data/projects/<projectId>/collab/state/taskboard.json`
- `data/projects/<projectId>/collab/state/sessions.json`
- `data/projects/<projectId>/collab/state/role-reminders.json`
- `data/projects/<projectId>/collab/events.jsonl`
- `data/projects/<projectId>/collab/inbox/*.jsonl`

### Workflow

- `data/workflows/templates/<templateId>.json`
- `data/workflows/runs/<runId>/run.json`
- `data/workflows/runs/<runId>/task-runtime.json`
- `data/workflows/runs/<runId>/sessions.json`
- `data/workflows/runs/<runId>/events.jsonl`
- `data/workflows/runs/<runId>/inbox/<role>.jsonl`
- `data/workflows/runs/<runId>/role-reminders.json`

## 8. 异常与边界

| 场景                          | 处理                                                |
| ----------------------------- | --------------------------------------------------- |
| 文件不存在                    | 返回默认状态或按需初始化                            |
| JSON/JSONL 解析失败           | 抛数据层错误，不伪装业务成功                        |
| UoW 回调失败                  | 回滚 staged writes                                  |
| scope 不存在                  | repository 返回空或抛 not found，由上层翻译业务错误 |
| project runtime 未 drain 完成 | 拒绝删除 project                                    |

## 9. 验证基线

- `server/src/__tests__/repository-runtime.test.ts`
- `server/src/__tests__/storage-transaction.test.ts`
- `server/src/__tests__/task-actions-durability.test.ts`
- `server/src/__tests__/project-admin-service.test.ts`
- `pnpm check:boundaries:strict`
- `pnpm --filter @autodev/server build`
- `pnpm --filter @autodev/server test`
- `pnpm test`
- discuss E2E baseline 复验通过，delete/recreate 后不再复现旧的 seed task 可见性丢失
