# Orchestrator Shared Abstraction Plan (2026-03-31)

Status: `实装`  
Scope: `server` only (V3 hard cut)

## current state

- shared 骨架已接管主路径：
  - `shared/dispatch-template.ts`
  - `shared/launch-template.ts`
  - `shared/runner-template.ts`
  - `shared/message-routing-template.ts`
  - `shared/task-action-template.ts`
  - `shared/tick-pipeline.ts`
- project/workflow dispatch service 已收薄为 façade + adapter 装配
- message routing 的 UoW 执行入口已统一为：
  - `executeOrchestratorMessageRoutingInUnitOfWork`
- discuss 解析统一为：
  - `normalizeOrchestratorDiscussReference(...)`
- routing scope-only UoW runner 统一为：
  - `createOrchestratorMessageRoutingUnitOfWorkRunner(...)`
- launch/routing 错误文案归一为：
  - `resolveOrchestratorErrorMessage(...)`
- workflow launch helper 硬切完成：
  - 删除 `workflow-dispatch-launch-support.ts`
  - lifecycle helper 并入 `workflow-dispatch-launch-adapter.ts`
- workflow routing helper 硬切完成：
  - 删除 `workflow-message-routing-internal.ts`
  - route target/envelope/event 流程并入 `workflow-message-routing-service.ts`
- project launch helper 硬切完成：
  - 删除 `project-dispatch-launch-support.ts`
  - lifecycle payload/terminal append/helper 收口到 `project-dispatch-launch-adapter.ts`
- project routing helper 硬切完成：
  - 删除 `project-message-routing-internal.ts`
  - route target/session/discuss/event 流程收口到 `project-message-routing-service.ts`
- project routing contracts 中间模块硬切完成：
  - 删除 `project-message-routing-contracts.ts`
  - routing input/context/error 类型收口到 `project-message-routing-service.ts`
- project launch adapter 内部导出收窄：
  - 移除无业务引用导出 `SyncDispatchRunResult`
  - `ProjectDispatchLaunch*` 内部类型改为文件内私有声明
- completion 共性策略已上提 shared：
  - `shared/completion-policy.ts`
  - `resolveOrchestratorMayBeDoneSettings(...)`
  - `countOrchestratorTaskDispatches(...)`
  - `hasOrchestratorSuccessfulRunFinishEvent(...)`
  - `isOrchestratorTerminalTaskState(...)`
  - `isOrchestratorValidProgressContent(...)`

## mergeable modules

- dispatch loop skeleton + single-flight gate
- launch/runner lifecycle skeleton
- message routing pipeline（resolve -> normalize -> persist -> touch）
- dispatch terminal-state 读取与去重判定
- route result normalization 与 shared payload 基元
- manager chat message type 与 route-result 基础字段 contract
- MAY_BE_DONE 配置与 completion 计数/输出有效性判定

## non-mergeable modules

- project provider resume/fallback 与进程终止细节
- workflow runtime convergence 与 auto-finish 规则
- project taskboard 与 workflow run/runtime 持久化模型
- project `dispatchMessage` 与 workflow `sendRunMessage` 的域策略语义

## shared abstraction target

- 不新增第二套 shared contract 家族，继续沿用现有 shared contract family
- shared 层只承载稳定编排骨架；域特有行为保留在 adapter/policy
- 迁移规则固定为“替换主路径 + 同轮删旧”，不保留并存兼容层

## known issues

- observed flaky regression（观察项，非稳定复现）：
  - `fetch bad port`
  - `workflow-block-propagation` 偶发时序抖动
- 本轮已同轮压稳：
  - `workflow-task-runtime-api`
  - `session-timeout-closure`
- 当前结构风险：
  - project/workflow dispatch adapter 内仍有部分域分支密度偏高
  - task-action 域内 validator 与 emit 路径仍有继续收敛空间

## remaining work

1. 继续压缩 project/workflow dispatch adapter 内高密度分支，维持 façade 薄层。
2. 继续清理 shared 层剩余低复用导出，保持 contract 家族收敛且稳定。
3. 仅在收口阻塞时再推进 task-action 非 report 路径的 apply/converge/emit 细化，不扩新增 contract 命名。

## verification snapshot (2026-03-31)

- `pnpm --filter @autodev/server build`: passed
- `pnpm --filter @autodev/server test`: passed (2 consecutive runs)
- flaky focus rerun passed:
  - `pnpm --filter @autodev/server run test -- --test-name-pattern "workflow-block-propagation|workflow-task-runtime-api|session-timeout-closure|bad port"`
- latest full regression snapshot: `tests 313 / pass 308 / fail 0 / skipped 5`
- flaky focused rerun passed (`3/3`), including `workflow-block-propagation / workflow-task-runtime-api / session-timeout-closure`
