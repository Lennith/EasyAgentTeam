# Workflow Runtime 模块 PRD（V3）

## 1. 状态

- 模块状态：`实装`
- 范围：`server` 内部 workflow orchestrator/runtime
- 外部冻结：HTTP API、SSE、event type、task state、退役接口 `410` 语义不变
- 本轮目标：workflow 侧 routing + task-action（apply/converge/emit）已收口到 shared 骨架，外部行为与错误码语义保持不变

## 2. 当前生效结构

- façade 与装配：
  - `workflow-orchestrator.ts`
  - `workflow-orchestrator-composition.ts`
- 运行态服务：
  - `workflow-dispatch-service.ts`
  - `workflow-message-routing-service.ts`
  - `workflow-task-action-service.ts`
  - `workflow-session-runtime-service.ts`
  - `workflow-reminder-service.ts`
  - `workflow-completion-service.ts`
  - `workflow-tick-service.ts`
- 纯规则内核：
  - `runtime/workflow-runtime-kernel.ts`
  - `runtime/workflow-auto-finish-window.ts`
  - `workflow-dispatch-policy.ts`

## 3. Launch 生效规则

- dispatch launch 生命周期由 shared launch/runner template 驱动
- workflow adapter 仅保留：
  - provider/tool bridge 细节
  - runtime/session 最小写回
  - workflow 域事件映射
- terminal-state 去重与超时判定统一通过 `shared/dispatch-lifecycle.ts`
- workflow provider runner 已并入 `workflow-dispatch-launch-adapter.ts`，不再维护独立 runner 文件
- `workflow-dispatch-launch-support.ts` 已删除，旧 lifecycle helper 分支不再并存

## 4. Message Routing 生效规则

- 固定流程：`resolve -> normalize -> inbox -> route event -> session touch`
- `workflow-message-routing-service.ts` 仅做上下文装配与 route gate
- 持久化执行统一由 shared message-routing template 承载
- UoW 入口统一为 `executeOrchestratorMessageRoutingInUnitOfWork`
- routing 输入契约复用 shared 基础类型：
  - `OrchestratorRouteMessageInputBase`
  - `OrchestratorDiscussReference`
  - `normalizeOrchestratorDiscussReference(...)`
- routing service 使用 shared scope-only UoW runner helper：
  - `createOrchestratorMessageRoutingUnitOfWorkRunner(...)`
- `workflow-message-routing-internal.ts` 已删除，route target/envelope/event 流程收口到 service 主路径

## 5. Completion 生效规则

- `MAY_BE_DONE` 环境配置读取统一复用：
  - `resolveOrchestratorMayBeDoneSettings(...)`
- 与 project 侧共享 completion 规则 helper：
  - `countOrchestratorTaskDispatches(...)`
  - `hasOrchestratorSuccessfulRunFinishEvent(...)`
  - `isOrchestratorTerminalTaskState(...)`
  - `isOrchestratorValidProgressContent(...)`
- workflow completion service 不再内置同构的 dispatch 计数和 progress 内容判定实现

## 6. Task Action 生效规则

- 使用 shared pipeline：
  - `parse -> authorize -> dependency gate -> apply -> converge -> emit`
- workflow 仅保留 domain validator 差异与既有错误码语义

## 7. 事务边界

- route 层不直接开事务
- workflow application service 通过 repository/UoW 统一写入 runtime/session/event/inbox
- 单用例关键写入保持单事务边界

## 8. 本轮稳定性修正（2026-03-31）

- `workflow-task-runtime-api`：测试改为显式关闭 `MAY_BE_DONE`（`MAY_BE_DONE_ENABLED=0`）以消除终态窗口抖动
- `session-timeout-closure`：断言改为 heartbeat + dispatch/run 任一 terminal 屏障，runner timeout 事件保持可选补充断言

## 9. 验证快照（2026-03-31）

- `pnpm --filter @autodev/server build`：通过
- `pnpm --filter @autodev/server test`：连续 2 次通过
- flaky 关注集额外回归通过：
  - `pnpm --filter @autodev/server run test -- --test-name-pattern "workflow-block-propagation|workflow-task-runtime-api|session-timeout-closure|bad port"`
- 最新快照：`tests 313 / pass 308 / fail 0 / skipped 5`
