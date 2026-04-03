# Orchestrator 模块 PRD（V3）

## 1. 状态

- 模块状态：`实装`
- 范围：`server` 内部重构（V3 hard cut）
- 外部冻结：API path、payload、status code、SSE、event type、task state、退役接口 `410` 语义不变
- 本轮目标：routing + task-action（apply/converge/emit）已完成收口；shared 主路径接管并删除被替换的 internal helper/compat 路径

## 2. 当前生效结构

- orchestrator 入口仅承担 façade + 依赖装配：
  - `server/src/services/orchestrator/project-orchestrator.ts`
  - `server/src/services/orchestrator/workflow-orchestrator.ts`
- shared 骨架为唯一主路径：
  - `shared/dispatch-template.ts`
  - `shared/launch-template.ts`
  - `shared/runner-template.ts`
  - `shared/message-routing-template.ts`
  - `shared/task-action-template.ts`
  - `shared/tick-pipeline.ts`
  - `shared/dispatch-lifecycle.ts`
  - `shared/completion-policy.ts`
- project/workflow 差异仅保留在 adapter/policy，不再在入口 service 手拼流程

## 3. Launch 生效规则

- 生命周期统一为：`started -> execute -> success/failure/timeout/escalation`
- shared launch/runner 负责编排骨架；域 adapter 仅保留：
  - provider/run 细节
  - 域状态最小写回
  - 域事件语义映射
- terminal-state 判定统一通过 `shared/dispatch-lifecycle.ts`

## 4. Routing 生效规则

- 唯一流程固定为：`target resolve -> envelope normalize -> inbox persist -> route event persist -> session touch`
- UoW 执行入口唯一化为：
  - `executeOrchestratorMessageRoutingInUnitOfWork`
- project/workflow routing service 只保留上下文装配与策略 gate
- manager/discuss 输入契约统一使用：
  - `OrchestratorRouteMessageInputBase`
  - `OrchestratorDiscussReference`
  - `normalizeOrchestratorDiscussReference(...)`
- routing scope-only UoW runner 统一通过：
  - `createOrchestratorMessageRoutingUnitOfWorkRunner(...)`

## 5. Completion 生效规则

- `MAY_BE_DONE` 配置解析统一通过：
  - `resolveOrchestratorMayBeDoneSettings(...)`
- completion 共性规则统一通过 shared helper：
  - `countOrchestratorTaskDispatches(...)`
  - `hasOrchestratorSuccessfulRunFinishEvent(...)`
  - `isOrchestratorTerminalTaskState(...)`
  - `isOrchestratorValidProgressContent(...)`
- project/workflow completion service 不再各自实现同构计数与配置解析逻辑

## 6. 本轮已落地收口（2026-03-31）

- workflow provider runner 文件已删除并并入 launch adapter：
  - 删除 `workflow-dispatch-provider-runner.ts`
  - 逻辑并入 `workflow-dispatch-launch-adapter.ts`
- workflow launch-support 旧 helper 已同轮删除：
  - 删除 `workflow-dispatch-launch-support.ts`
  - 生命周期辅助逻辑收口到 `workflow-dispatch-launch-adapter.ts`
- workflow message routing internal 旧 helper 已同轮删除：
  - 删除 `workflow-message-routing-internal.ts`
  - 目标解析、envelope 构建、route event 组装统一收口到 `workflow-message-routing-service.ts`
- project launch-support 旧 helper 已同轮删除：
  - 删除 `project-dispatch-launch-support.ts`
  - provider payload、runner lifecycle、terminal event append 统一收口到 `project-dispatch-launch-adapter.ts`
- project message routing internal 旧 helper 已同轮删除：
  - 删除 `project-message-routing-internal.ts`
  - target/session/discuss/event 组装统一收口到 `project-message-routing-service.ts`
- project message routing contracts 旧中间模块已同轮删除：
  - 删除 `project-message-routing-contracts.ts`
  - routing input/context/error 类型并入 `project-message-routing-service.ts`
- project launch adapter 内部 seam 收窄：
  - 移除无业务引用导出 `SyncDispatchRunResult`
  - `ProjectDispatchLaunch*` 内部类型改为文件内私有声明，保留运行时行为与外部接口不变
- manager chat message type 收敛为单一定义：
  - `server/src/domain/models.ts` 中 `MANAGER_CHAT_MESSAGE_TYPES` / `ManagerChatMessageType`
  - 统一校验函数 `isManagerChatMessageType(...)`
- message routing 结果基础结构统一为 shared 单定义：
  - `OrchestratorMessageRouteResult`
- discuss 解析归一到 shared helper，manager service 与 workflow teamtool bridge 复用同一解析流程
- launch/routing 错误文案归一复用：
  - `resolveOrchestratorErrorMessage(...)`
- completion 共性策略收敛为 shared helper：
  - `shared/completion-policy.ts`
- project dispatch façade 进一步收薄：
  - force task precheck 与 session 解析下沉到 `project-dispatch-session-helper.ts`
  - `project-dispatch-service.ts` 保留 scope resolve + adapter 装配 + public method
- shared contract 收窄：
  - 移除未使用 contract：`OrchestratorDispatchAdapter`、`OrchestratorRepositoryScope`、`OrchestratorScopeId`、`OrchestratorRunnerTerminalStatus`
  - 保留现有 shared contract family，不新增命名体系

## 7. 事务与数据边界

- route 层不直接开事务
- application service 通过 repository/UoW 持有事务边界
- 同一用例内 runtime/session/event/inbox/taskboard 关键写入保持单事务边界

## 8. 验证快照（2026-03-31）

- `pnpm --filter @autodev/server build`：通过
- `pnpm --filter @autodev/server test`：连续 2 次通过
- flaky 关注集额外回归通过：
  - `pnpm --filter @autodev/server run test -- --test-name-pattern "workflow-block-propagation|workflow-task-runtime-api|session-timeout-closure|bad port"`
- 最新快照：`tests 313 / pass 308 / fail 0 / skipped 5`

## 9. shared 边界冻结规则（2026-04-02）

### 9.1 冻结目标

- shared 骨架继续作为唯一主路径。
- project/workflow 差异继续收敛在 adapter/policy，不回流到入口 service 拼装。
- 本轮禁止扩展新的 shared 命名体系。

### 9.2 禁止新增项（本轮）

- 禁止新增 shared `compat` seam（含显式 compat 命名与等价兼容层）。
- 禁止新增 shared `helper` 聚合入口用于兜底历史路径。
- 禁止新增 shared `contract` 家族分叉（除非替换现有 contract 且完成一次性收口）。
- 禁止恢复 `*-internal.ts` 旧式编排中间层来绕开模板主路径。

### 9.3 允许变更项（本轮）

- adapter/policy 细节修正（provider 差异、域事件映射、策略 gate 调整）。
- shared 模板内部 bugfix（不新增命名层、不新增并行主路径）。
- 现有 shared contract 的等价收窄与死代码移除。

### 9.4 评审检查项（必查）

1. 入口 orchestrator service 是否仍保持 façade + 依赖装配角色。
2. 新增逻辑是否落在 adapter/policy，而不是额外的 shared compat/helper 层。
3. shared 目录是否引入新的 contract/helper/compat 命名 seam。
4. 对外 API path/payload/status/event type 是否保持冻结。

### 9.5 轻量边界检查入口

- 命令（默认非阻塞）：`pnpm check:boundaries`
- 严格模式（用于后续 CI 阻断预演）：`pnpm check:boundaries:strict`
