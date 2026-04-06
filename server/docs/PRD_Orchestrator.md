# Orchestrator 模块 PRD（V3）

## 1. 状态

- 模块状态：`实装`
- 范围：`server` 内部收敛重构（V3 hard cut）
- 外部冻结：API path、payload、status code、SSE、event type、task state、退役接口 `410` 语义不变
- 当前目标：在已完成 `launch + dispatch`、`message-routing-service`、`workflow dispatch/composition`、`workflow reminder/session authority`、`workflow completion/task report pipeline`、`workflow task create pipeline`、`project/workflow reminder shared decision loop`、`project dispatch service` 收敛基础上，继续只打剩余厚主干；优先删除总代码量、无效分叉与过度设计，外部契约保持不变

## 2. 当前生效结构

- orchestrator 根目录仅保留：
  - `server/src/services/orchestrator/index.ts`
  - `server/src/services/orchestrator/project/**`
  - `server/src/services/orchestrator/workflow/**`
  - `server/src/services/orchestrator/shared/**`
- orchestrator 入口只负责 facade + 依赖装配：
  - `project/project-orchestrator.ts`
  - `workflow/workflow-orchestrator.ts`
- shared 主路径只保留一套模板骨架：
  - `shared/launch-template.ts`
  - `shared/dispatch-template.ts`
  - `shared/dispatch-lifecycle.ts`
  - `shared/runner-template.ts`
  - `shared/message-routing-template.ts`
  - `shared/task-action-template.ts`
  - `shared/tick-pipeline.ts`
  - `shared/session-manager.ts`
  - `shared/completion-policy.ts`
  - `shared/reminder-runtime.ts`
- project / workflow 差异只允许保留在 runtime-specific adapter、policy、state-machine 与生命周期模块内；不允许把领域逻辑回流到 shared 的 compat/helper 薄层

## 3. Launch 生效规则

- `shared/launch-template.ts` 是唯一 launch 生命周期骨架，统一负责：
  - `createContext`
  - `appendStarted`
  - provider execute
  - `success/failure/timeout/escalation` 收尾
- `project/workflow` 的 `dispatch-launch-adapter` 只保留 facade 角色；域生命周期细节下沉到 runtime-specific lifecycle 模块
- project launch lifecycle 按职责拆分为：
  - `project/project-dispatch-launch-lifecycle.ts`：只负责 facade 装配与 lifecycle callback 接线
  - `project/project-dispatch-run-lifecycle.ts`：负责 provider payload / runner payload 构造、pending message confirm、task dispatched patch、terminal dispatch event append
  - `project/project-dispatch-provider-launch.ts`：负责 provider 执行、sync/async provider result 归一与 MiniMax-specific launch 收尾
- workflow launch lifecycle 按职责拆分为：
  - `workflow/workflow-dispatch-launch-lifecycle.ts`：只负责 facade 装配与 lifecycle callback 接线
  - `workflow/workflow-dispatch-run-lifecycle.ts`：负责 started/finished/failed/max-tokens event、terminal-state reconcile 与 session terminal patch
  - `workflow/workflow-dispatch-provider-launch.ts`：负责 prompt 组装、tool session launch 与 provider 执行入口
- project lifecycle 继续覆盖：
  - provider payload / runner payload 构造
  - pending message confirm
  - task dispatched patch
  - sync / async provider result 归一
  - terminal dispatch event append
- workflow lifecycle 继续覆盖：
  - tool-session launch prep
  - minimax config guard
  - max-tokens recovery event
  - timed-out / open-error / finished 收尾
- terminal-state 判定统一通过 `shared/dispatch-lifecycle.ts`

## 4. Dispatch 生效规则

- `shared/dispatch-template.ts` 是唯一 dispatch loop 骨架，统一负责：
  - loop preflight
  - single-flight gate
  - selection -> mutation -> execution
  - awaited launch 与 fire-and-forget 两种执行模式
  - `afterDispatch` / `afterLoop` 收尾
- `ProjectDispatchService` 与 `WorkflowDispatchService` 保留公开 service 入口，但内部直接调用 `runOrchestratorDispatchTemplate(...)`
- project dispatch 主循环继续按职责拆分为：
  - `project/project-dispatch-service.ts`：只负责 public service seam 与 adapter 装配
  - `project/project-dispatch-loop.ts`：负责 loop state、authoritative session iteration、selection/dispatch/finalize 主路径
  - `project/project-dispatch-session-resolution.ts`：负责 force-dispatch task gate、session auto-bootstrap、effective/ordered session resolve
- workflow dispatch 主循环继续按职责拆分为：
  - `workflow/workflow-dispatch-service.ts`：只负责 facade、adapter 装配与 public dispatch 入口
  - `workflow/workflow-dispatch-loop.ts`：负责 loop state、preflight、mutation、execution、finalize 主路径
  - `workflow/workflow-dispatch-types.ts`：负责 row/result/outcome 等稳定 dispatch contract
- `project-dispatch-loop-pipeline.ts` 与 `workflow-dispatch-loop-pipeline.ts` 已删除，不再保留厚中间 class 层
- project dispatch 保持 await provider 结果的现有语义
- workflow dispatch 保持 fire-and-forget 的现有语义
- `selection-adapter` 只允许做模板接线所需的最小接口调整，不额外扩张抽象

## 5. Routing 生效规则

- routing 主路径保持不变：
  - `target resolve -> envelope normalize -> inbox persist -> route event persist -> session touch`
- `shared/message-routing-template.ts` 是唯一 routing skeleton
- `project/workflow` 的 routing service 只保留 facade / UoW 接线 / 域策略 gate
- project routing lifecycle 按职责拆分为：
  - `project/project-message-routing-lifecycle.ts`：仅保留 public export
  - `project/project-message-routing-domain.ts`：负责 target/session/event/result 等领域装配
  - `project/project-message-routing-routes.ts`：负责 deliver / manager-message / task-assignment 路径接线
- workflow routing lifecycle 按职责拆分为：
  - `workflow/workflow-message-routing-lifecycle.ts`：仅保留 public export
  - `workflow/workflow-message-routing-domain.ts`：负责 authoritative target / envelope / route event / route result 装配
  - `workflow/workflow-message-routing-routes.ts`：负责 route permission gate 与 routeMessage 主路径接线
- manager-message 路径的 envelope / result / event pair 骨架继续优先收敛到 shared 模板
- project runtime 保持：
  - task discuss 重写
  - role-session bootstrap / map sync
  - task-assignment 特有事件
- workflow runtime 保持：
  - route-table permission gate
  - authoritative session resolve
  - workflow-specific route event payload
- routing shared seam 继续有效：
  - `executeOrchestratorMessageRoutingInUnitOfWork(...)`
  - `createOrchestratorMessageRoutingUnitOfWorkRunner(...)`
  - `OrchestratorRouteMessageInputBase`
  - `OrchestratorDiscussReference`
  - `normalizeOrchestratorDiscussReference(...)`
- reminder shared seam 继续有效：
  - `runOrchestratorReminderLoop(...)`
  - `buildOrchestratorReminderRoleStatePatch(...)`
  - `buildOrchestratorReminderSchedulePatch(...)`
  - `buildOrchestratorReminderTriggeredPatch(...)`
  - `evaluateOrchestratorReminderEligibility(...)`
- project reminder 继续按职责拆分为：
  - `project/project-reminder-service.ts`：负责 public seam、manual reset，以及 project-specific session/open-task resolve 与 trigger/redispatch 动作
- workflow reminder 继续按职责拆分为：
  - `workflow/workflow-reminder-service.ts`：仅保留 public service seam
  - `workflow/workflow-reminder-cycle.ts`：负责 workflow-specific session/open-task resolve 与 trigger/redispatch 动作

## 6. Completion、Task Action 与其他冻结规则

- `MAY_BE_DONE` 配置解析统一通过 `resolveOrchestratorMayBeDoneSettings(...)`
- completion 共性规则统一通过：
  - `countOrchestratorTaskDispatches(...)`
  - `hasOrchestratorSuccessfulRunFinishEvent(...)`
  - `isOrchestratorTerminalTaskState(...)`
  - `isOrchestratorValidProgressContent(...)`
- workflow completion 继续按职责拆分为：
  - `workflow/workflow-completion-service.ts`：只负责 public service seam 与 capability module 调度
  - `workflow/workflow-completion-may-be-done.ts`：负责 dispatch threshold、recent event window、valid output probe 与 `TASK_MAY_BE_DONE_MARKED` 事件写入
  - `workflow/workflow-completion-finalize.ts`：负责 stable tick 计算、reset/tick/finalize 事件与 run finish patch
- workflow task report pipeline 继续按职责拆分为：
  - `workflow/workflow-task-report-processing.ts`：只负责 `runOrchestratorTaskActionPipeline(...)` 接线与 phase 编排
  - `workflow/workflow-task-report-guard.ts`：负责 predicted-state、dependency gate、`TASK_DEPENDENCY_NOT_READY` 错误构造
  - `workflow/workflow-task-report-application.ts`：负责 blocked state 归一、task transition apply、session touch、runtime converge 与 `TASK_REPORT_APPLIED` 结果构造
- workflow task create pipeline 继续按职责拆分为：
  - `workflow/workflow-task-create-processing.ts`：只负责 `runOrchestratorTaskActionPipeline(...)` 接线与 phase 编排
  - `workflow/workflow-task-create-guard.ts`：负责 task payload 解析、owner role 校验、dependency merge 与 ancestor dependency gate
  - `workflow/workflow-task-create-application.ts`：负责 task append、runtime converge 与 create result 构造
- tick / timeout / hold-state sync 统一通过：
  - `runAdapterBackedOrchestratorTickLoop(...)`
  - `syncOrchestratorHoldState(...)`
  - `hasOrchestratorSessionHeartbeatTimedOut(...)`
- workflow composition 的 transient state 继续按职责收敛为：
  - `workflow/workflow-orchestrator-composition.ts`：只负责 service wiring 与 composition 返回
  - `workflow/workflow-orchestrator-state.ts`：负责 activeRunIds、runHoldState、runAutoFinishStableTicks、sessionHeartbeatThrottle、in-flight gate 的 scoped 清理与裁剪
- workflow session runtime authority 继续按职责拆分为：
  - `workflow/workflow-session-runtime-service.ts`：负责 public session runtime seam、heartbeat、list/register/timeout 委托
  - `workflow/workflow-session-authority.ts`：负责 run load、roleSessionMap 持久化、authoritative session resolve、register 归位

## 7. 边界冻结规则

- 收敛原则优先级：
  - 优先减少总代码量与放置判断成本
  - 优先删除无效分叉，不为目录对称保留两份 80% 相同的逻辑
  - 禁止为了“结构看起来整齐”新增薄包装或并行抽象
- 禁止新增 shared `compat` seam
- 禁止恢复 `*-internal.ts` 风格的编排中间层来绕开 shared 模板
- 禁止在 `server/src/services/orchestrator/` 根目录新增平铺的 `project-*` / `workflow-*` 文件
- 允许的 shared 修改仅限：
  - 模板内聚合
  - 重复骨架收口
  - 对现有 shared contract 的等价收敛

## 8. 验证要求

- 必跑：
  - `pnpm check:boundaries:strict`
  - `pnpm --filter @autodev/server build`
  - `pnpm --filter @autodev/server test`
- 重点回归：
  - project launch adapter 的 sync/async provider 行为不变
  - workflow launch adapter 的 minimax guard / max-tokens recovery / timeout/open-error 行为不变
  - project dispatch 的 force-dispatch / session bootstrap / duplicate gate 语义不变
  - workflow dispatch 的 hold / budget / concurrency / fire-and-forget 语义不变
  - project manager-message / deliver / task-assignment routing 行为不变
- workflow route permission / authoritative session / event payload 行为不变
- workflow `MAY_BE_DONE` 的 dispatch threshold + valid output 语义不变
- workflow task report 的 dependency gate / partial apply / runtime converge 语义不变
- workflow task create 的 owner role / parent dependency merge / ancestor dependency gate / runtime converge 语义不变
  - project/workflow reminder 的 role state patch / schedule / trigger / redispatch 语义不变

## 9. 当前验证快照（2026-04-06）

- `pnpm check:boundaries:strict`：通过
- `pnpm --filter @autodev/server build`：通过
- `pnpm --filter @autodev/server test`：通过
- 最新快照：`tests 322 / pass 317 / fail 0 / skipped 5`
