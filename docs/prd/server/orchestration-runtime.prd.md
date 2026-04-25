# 编排运行时 PRD（最后更新：2026-04-23）

## 状态

- 文档状态：`实装`

## 目标

后端编排运行时负责在 project 和 workflow 两种模式下选择焦点任务、创建或复用 session、执行调度、发出 reminder，并把运行结果写回统一的任务与会话状态。

## 当前有效能力

- project / workflow 都支持自动调度与手动调度
- 调度围绕单个 focus task 进行，不把多个无关任务拼进一次 dispatch
- reminder 只在焦点任务没有未收敛后代时触发
- 自动调度与 reminder 只围绕事实态任务运行，不引入近似终态或待确认终态
- 历史运行时中遗留的非正式终态会在读路径归一为正式终态后再参与收敛
- provider 配置错误会被识别为可诊断错误，不再伪装成普通运行失败
- MiniMax 上游 `429`、明显 `5xx/529` 与连接超时这类暂态错误会归一为可恢复运行错误
- project / workflow 的 runner failure transition 由统一决策规则决定最终 session 落态、cooldown 与错误事件，不再允许各自拼装不一致的失败收口
- session 的活跃、阻塞、终态由编排生命周期统一收口
- project / workflow 都提供 scope 内 recovery 视图所需的会话恢复读模型，围绕 session、当前任务、最近失败、cooldown 与最近恢复审计片段聚合恢复信息
- Recovery Center 的可操作性由后端统一 action policy 决定，不允许前端仅凭 session.status 自行推导 `dismiss` / `repair`
- project / workflow 都支持手动 dismiss、repair 与 retry-dispatch，并且对齐到同一套恢复语义：dismiss 终止当前运行并清空当前任务，repair 只允许恢复到受 policy 允许的 `idle` 或 `blocked`，retry-dispatch 只允许在 `idle`、非 cooldown、具备 authoritative failure anchor、authoritative role mapping 仍匹配且本地进程状态已确认不再运行的 session 上触发
- 所有 `requires_confirmation=true` 的 recovery command 都必须显式携带确认字段；缺少确认时返回稳定错误，而不是隐式执行高风险操作
- dismiss / repair / retry-dispatch 的 command contract 由后端统一定义；route 只做请求解析与调用，不再各自拼装恢复规则
- retry-dispatch command 采用 mandatory optimistic guard：公开 route 继续兼容 snake_case / camelCase 字段别名，但 command service 必须要求 `expected_status='idle'`、`expected_role_mapping='authoritative'`，并且至少携带 `expected_last_failure_event_id` 或 `expected_last_failure_dispatch_id`；fresh session 仍有 `currentTaskId` 时还必须携带 `expected_current_task_id`
- 缺失 mandatory retry guard 时必须返回稳定 `409 + SESSION_RETRY_GUARD_REQUIRED`，并给出刷新 Recovery Center 后按最新快照重试的 `next_action`；guard mismatch、policy 不允许与 orchestrator 拒绝继续统一返回 `409 + SESSION_RETRY_DISPATCH_NOT_ALLOWED`
- retry-dispatch 默认强制 `onlyIdle=true` 且不暴露公开 `force` 开关；只有后端内部显式高风险恢复路径才允许覆盖该默认值
- reminder 触发后的自动 redispatch 也必须遵守 `onlyIdle=true`；reminder 只负责补发提醒与驱动 idle session 重新进入正常 dispatch，不允许绕开 idle gate 抢占运行中或未完成收口的 session
- workflow task runtime 的 read-modify-write 变更必须按 `run_id` 串行执行；`TASK_REPORT`、runtime convergence、dispatch afterLoop 和 completion finalize 不能并发读取同一旧快照后再互相覆盖，避免较晚提交的 stale runtime 把更新后的任务状态回滚；当前串行化是单 backend / 单进程内存锁模型，不声明支持多进程共享同一个 `dataRoot`
- session 恢复上下文除了 `last_failure_at / last_failure_kind` 外，还必须沉淀 `last_failure_event_id`、`last_failure_dispatch_id`、`last_failure_message_id`、`last_failure_task_id`，供 recovery read model 展示与 retry-dispatch guard 回填；其中 `last_failure_event_id` 或 `last_failure_dispatch_id` 才能单独作为 authoritative retry anchor，`message_id / task_id` 仅作为增强上下文，不单独放开 retry
- retry-dispatch 审计事件语义分为 `SESSION_RETRY_DISPATCH_REQUESTED`、`SESSION_RETRY_DISPATCH_ACCEPTED`、`SESSION_RETRY_DISPATCH_REJECTED`；读模型兼容历史 `REQUESTED`，但新实现必须区分请求、接受与拒绝，并在同一 retry command 生成统一的 `recovery_attempt_id`
- `recovery_attempt_id` 继续不写入 session 主模型，但 recovery read model 必须把它产品化为 `runtime-recovery.items[].recovery_attempts[]`：按 `recovery_attempt_id` 归并 retry-dispatch 的 requested / accepted / rejected 审计事件，以及对应的 `ORCHESTRATOR_DISPATCH_STARTED` / `ORCHESTRATOR_DISPATCH_FINISHED` / `ORCHESTRATOR_DISPATCH_FAILED`
- project / workflow recovery read model 必须优先读取与 runtime event log 同步维护的 sidecar hot index，而不是每次全量扫描 `events.jsonl`；hot index 只对 recovery 相关事件家族增量维护 `latest_failure_event`、最近审计片段与每个 session 最近有限条 attempt preview。缺失、损坏或 schema 不兼容时允许从 append-only event log 只扫描 recovery 相关事件重建一次后继续读取
- attempt full history 不再常驻在 scope 级 hot index 内；detail endpoint 使用按 session 拆分的 attempt archive 作为 authoritative full-history 源。attempt archive 是 session 级 append-only 文件，只沉淀该 session 的 recovery-attempt 生命周期事件；archive 缺失、损坏或 schema 不兼容时，只允许按被请求 session 从 append-only event log 过滤重建，不预先重建全部 session archive
- append 路径必须先按 event family 预过滤：只有 runner failure、`SESSION_RETRY_DISPATCH_*`、`ORCHESTRATOR_DISPATCH_*`、`SESSION_STATUS_*` 与 `SESSION_DISMISS_EXTERNAL_RESULT` 这类会影响 recovery 读模型的事件，才允许触碰 hot index 或 attempt archive；其余事件只追加到 `events.jsonl`，不读、不锁、不写任何 recovery sidecar 文件
- `runtime-recovery.items[].recovery_attempts[]` 默认返回最近有限条 attempt preview，避免 Recovery Center 长历史无界渲染；main `runtime-recovery` 只接受正整数 `attempt_limit`，session 级 full history 改由 `GET /api/projects/:id/sessions/:session_id/recovery-attempts` 与 `GET /api/workflow-runs/:run_id/sessions/:session_id/recovery-attempts` 提供。main endpoint 中每条 attempt preview 只稳定返回 `recovery_attempt_id`、`status`、`integrity`、`missing_markers`、`requested_at`、`last_event_at`、`ended_at`、`dispatch_scope` 与 `current_task_id`，不再携带 `events[]`
- hot index 中的 recent attempts 必须在写时维护为 newest-first 的 capped 列表，避免主 recovery 读路径退化为“先排序完整 attempt 历史再截断”；默认 bounded 读取的外部表现保持不变，但底层必须是真正有界的 hot read
- session detail endpoint 返回的 full-history attempts 继续稳定返回 `status`、`integrity`、`missing_markers`、时间戳、dispatch scope、current task 与按时间正序排列的 `events[]`；当多个审计事件落在同一毫秒时，排序必须优先遵循恢复生命周期顺序（requested -> accepted/rejected -> dispatch started -> dispatch finished/failed），不能退化为按随机 `eventId` 排序
- `runtime-recovery.items[].latest_events[]` 继续保留为兼容字段，但 Recovery Center 主展示迁移到 `recovery_attempts[]`；旧历史中没有 `recovery_attempt_id` 的事件不做 synthetic backfill，只保留在兼容 summary 视图中
- dismiss 采用“外部停止结果审计 -> 本地 dismiss 落盘”两阶段审计；外部停止未确认时不允许继续写本地 dismiss 状态
- dismiss / repair 的对外响应会返回统一 command contract，包含前后状态、外部取消结果、本地终止结果、映射清理结果与 warnings
- recovery read model 与 recovery command enforcement 共享同一套 policy context builder，确保 Recovery Center 展示与实际命令约束一致；当 session 非 `running` 但仍保留 `agentPid` 时，policy 会把进程状态视为 `unknown`，只允许先执行 dismiss，不允许 repair 或 retry-dispatch
- 任务消息和 discuss 消息只有在运行真正成功后才会被确认消费；瞬时运行错误会把消息留在未消费态，并保留 session 的可重试状态
- project 的未消费消息在命中可恢复暂态错误后，必须允许在 cooldown 结束后围绕同一 message 重新派发；不能因为 `lastInboxMessageId` 命中上一次失败消息而把同一条未消费消息永久拦成 `already_dispatched`
- provider 暂态错误不会把 session 直接落成 `dismissed`；编排会把 session 置回 `idle` 并写入 cooldown，等待下一轮 reminder / tick 重试
- project provider audit 仍只认最终 active `roleSessionMap` 中的 authoritative session；历史 dismissed session 不参与 provider audit 结论
- `project + codex` 运行时必须把有效 JSON item、尾段终态工具调用与 turn 收尾视作真实活跃信号，heartbeat 写入失败必须留下内部审计事件，不能静默吞掉
- workflow pre-dispatch session touch 失败不能静默吞掉，必须先写 `WORKFLOW_PRE_DISPATCH_SESSION_TOUCH_FAILED` 审计事件；无论审计追加是否成功，都必须中止本次 dispatch，不能继续修改内存 session、移除 inbox 消息、扣减 budget 或启动 provider
- workflow run scoped transient clear 会提升 mutation generation：已在执行中的 mutation 不被强杀，但仍在等待旧 tail 的 pending mutation 必须拒绝执行，防止 clear 之后的旧写覆盖新一代 run 状态
- project / workflow timeout scanner 在真正执行 heartbeat timeout kill 前必须通过独立 evidence 纯函数重判当前 running session：只要 heartbeat 已刷新，或当前 task 已被同一 session 最近成功上报为 `DONE / BLOCKED_DEP / CANCELED`，就跳过本次 timeout kill，避免刚完成上报的 session 被误 dismiss
- timeout scanner 自身只负责加载数据、执行 close / terminate、关闭 dispatch / run、释放 in-flight gate 与写审计；是否应当关闭由 `project-session-timeout-evidence` / `workflow-session-timeout-evidence` 纯函数模块决策，并返回 `should_close`、protection 标记、`evidence_event_id` 与稳定 `decision_reason`
- project / workflow 的 timeout soft-close、dismiss 与 repair 在把 dispatch 收口到非运行态后，必须同步释放对应 session 的内存态 in-flight dispatch gate；一旦 dispatch 已被事件流判定 closed，就不允许残留 gate 继续把后续 reminder redispatch 或手动 retry 错误挡成 `session_busy`
- project discuss 消息在路由到目标角色前必须做 task 绑定归一：如果回复消息误绑到发送方已完成任务，但目标角色存在依赖该任务的非终态焦点任务，则消息必须重绑到目标角色的那个焦点任务，确保后续 redispatch 能按 active focus task 选中该 discuss reply
- 工程分解阶段在首次收敛前必须先产出至少一个非 manager 执行子任务；只有分解结果已经落成可执行任务树时，父阶段才能报告完成
- 工程分解阶段生成的子任务只允许覆盖当前阶段可立即推进的执行工作，不允许把依赖未来 phase 的 QA / release 工作提前挂到当前阶段子树里

## 外部语义

- project 编排控制：`/api/projects/:id/orchestrator/*`
- workflow 编排控制：`/api/workflow-runs/:run_id/orchestrator/*`
- project recovery：`/api/projects/:id/runtime-recovery`
- workflow recovery：`/api/workflow-runs/:run_id/runtime-recovery`
- project recovery attempts detail：`/api/projects/:id/sessions/:session_id/recovery-attempts`
- workflow recovery attempts detail：`/api/workflow-runs/:run_id/sessions/:session_id/recovery-attempts`
- project dismiss / repair：`/api/projects/:id/sessions/:session_id/dismiss|repair`
- workflow dismiss / repair：`/api/workflow-runs/:run_id/sessions/:session_id/dismiss|repair`
- project retry-dispatch：`/api/projects/:id/sessions/:session_id/retry-dispatch`
- workflow retry-dispatch：`/api/workflow-runs/:run_id/sessions/:session_id/retry-dispatch`
- 对外保持现有 API path、payload、status code 与事件语义不变
- provider 错误、runtime failure 事件与 `agent-chat` SSE 对外字段统一使用 snake_case，包括 `next_action`、`raw_status`、`cooldown_until`

## 兼容边界

- provider 仅支持当前正式 provider 集合
- 历史运行时中遗留的非正式终态会先经过一次性迁移再参与当前编排；正式实现不再保留长期读路径兼容分支
- reminder、redispatch、timeout recovery 属于主场景内机制，不单独暴露为独立产品面
