# Workflow Runtime 模块 PRD（V3）

## 1. 状态

- 模块状态：`实装`
- 范围：`server` 内部 workflow orchestrator / runtime / recurring dispatcher
- 外部冻结：HTTP API、event type、task state、retired `410` 语义保持兼容

## 2. 当前目标

- Workflow 仅在 `workflow run` 维度支持自动循环与定时派生
- `workflow-recurring-dispatcher` 独立于 `workflow-orchestrator` tick core
- Loop / Schedule 新建子 run 时复用父 run 的业务配置，但不复用 `runId`
- 需要区分：
  - `autoDispatchRemaining`：当前 run 的剩余自动派发预算
  - `autoDispatchInitialRemaining`：当前 run 以及未来 recurring 子 run 的初始预算基线

## 3. Run 模型

`WorkflowRunRecord` 当前有效字段：

- `mode`: `none | loop | schedule`
- `loopEnabled`
- `scheduleEnabled`
- `scheduleExpression`
- `isScheduleSeed`
- `originRunId`
- `lastSpawnedRunId`
- `spawnState`
- `autoDispatchEnabled`
- `autoDispatchRemaining`
- `autoDispatchInitialRemaining`
- `holdEnabled`
- `reminderMode`

约束：

- `loop` 与 `schedule` 互斥
- 旧数据若缺失 `autoDispatchInitialRemaining`，读取时默认回退到 `autoDispatchRemaining`

## 4. Auto Dispatch 语义

- `autoDispatchRemaining` 是运行时字段，只表示当前 run 还剩多少次自动 task dispatch
- 自动 task dispatch 成功时，仅扣减当前 run 的 `autoDispatchRemaining`
- `autoDispatchInitialRemaining` 是配置基线：
  - `POST /api/workflow-runs` 中 `auto_dispatch_remaining` 同时写入 `autoDispatchRemaining` 与 `autoDispatchInitialRemaining`
  - `PATCH /api/workflow-runs/:run_id/orchestrator/settings` 中若传入 `auto_dispatch_remaining`，同时更新两个字段
- Loop / Schedule 派生子 run 时：
  - 子 run `autoDispatchInitialRemaining = source.autoDispatchInitialRemaining`
  - 子 run `autoDispatchRemaining = source.autoDispatchInitialRemaining`

## 5. Recurring 语义

### 5.1 Loop

- 触发条件：`mode=loop && loopEnabled=true && run.status=finished`
- 动作：对单个 source run 获取带心跳的派生租约，创建新的 workflow run 并立即启动
- 子 run 继承：
  - template / workspace
  - variables / task overrides / resolved tasks
  - route table / discuss rounds / role session map
  - recurring 运行模式
  - auto dispatch / hold / reminder 配置
- 追踪：
  - 子 run 写入 `originRunId`
  - 仅当子 run 启动成功后，父 run 才回填 `lastSpawnedRunId`
- 若子 run 启动失败：
  - 失败子 run 标记为 `failed`
  - 父 run 不消费本次 loop 机会，后续 tick 可继续重试
- 若 dispatcher 在派生过程中失去租约：
  - 不提交本次 spawn 的父 run 追踪状态
  - 已创建但未安全提交的子 run 标记为 `failed`

### 5.2 Schedule

- 触发对象：`mode=schedule && scheduleEnabled=true && isScheduleSeed=true`
- 表达式格式：`MM-DD HH:MM`
- `MM / DD / 分钟` 支持 `XX`
- 同一个 schedule seed 任一时刻最多只有一个活跃子 run
- dispatcher 对单个 schedule seed 获取带心跳的派生租约，避免重叠 tick / 多进程重复 spawn
- schedule 派生子 run 不再继承 schedule seed 身份：
  - `mode=none`
  - `scheduleEnabled=false`
  - `isScheduleSeed=false`
- 仅当子 run 启动成功后，才更新 `lastSpawnedRunId` 与 `spawnState.lastWindowKey/activeRunId`
- 若子 run 启动失败：
  - 失败子 run 标记为 `failed`
  - 当前窗口不视为已消费，后续分钟仍可重试
- 若 dispatcher 在派生过程中失去租约：
  - 不提交 `lastSpawnedRunId` 与窗口状态
  - 已创建但未安全提交的子 run 标记为 `failed`

## 6. API 生效口径

### 6.1 Run 创建 / 查询

- `POST /api/workflow-runs`
  - `auto_dispatch_remaining` 设定当前 run 的剩余额度与初始额度
- `GET /api/workflow-runs`
- `GET /api/workflow-runs/:run_id`
  - 返回 `autoDispatchRemaining`
  - 返回 `autoDispatchInitialRemaining`

### 6.2 Orchestrator Settings

- `GET /api/workflow-runs/:run_id/orchestrator/settings`
  - 返回 `auto_dispatch_remaining`
  - 返回 `auto_dispatch_initial_remaining`
- `PATCH /api/workflow-runs/:run_id/orchestrator/settings`
  - 若请求体带 `auto_dispatch_remaining`，同时更新 remaining 与 initial

## 7. 验收口径

- Loop 链路中新子 run 的 `originRunId` 连续可追踪
- `autoDispatchInitialRemaining` 在同一 recurring 链路中保持继承一致
- `autoDispatchRemaining` 允许因自动派发而递减，不再作为父子 run 配置一致性校验字段
- 停止 recurring 后不得继续产生新 run
- `pnpm e2e:workflow:loop30` 通过
- `pnpm e2e:workflow` 通过
