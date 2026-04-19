# 编排运行时 PRD（最后更新：2026-04-19）

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
- project / workflow 都支持手动 dismiss 与 repair，并且对齐到同一套恢复语义：dismiss 终止当前运行并清空当前任务，repair 只允许恢复到受 policy 允许的 `idle` 或 `blocked`
- dismiss / repair 的对外响应会返回统一 command contract，包含前后状态、外部取消结果、本地终止结果、映射清理结果与 warnings
- 任务消息和 discuss 消息只有在运行真正成功后才会被确认消费；瞬时运行错误会把消息留在未消费态，并保留 session 的可重试状态
- provider 暂态错误不会把 session 直接落成 `dismissed`；编排会把 session 置回 `idle` 并写入 cooldown，等待下一轮 reminder / tick 重试
- 工程分解阶段在首次收敛前必须先产出至少一个非 manager 执行子任务；只有分解结果已经落成可执行任务树时，父阶段才能报告完成
- 工程分解阶段生成的子任务只允许覆盖当前阶段可立即推进的执行工作，不允许把依赖未来 phase 的 QA / release 工作提前挂到当前阶段子树里

## 外部语义

- project 编排控制：`/api/projects/:id/orchestrator/*`
- workflow 编排控制：`/api/workflow-runs/:run_id/orchestrator/*`
- project recovery：`/api/projects/:id/runtime-recovery`
- workflow recovery：`/api/workflow-runs/:run_id/runtime-recovery`
- project dismiss / repair：`/api/projects/:id/sessions/:session_id/dismiss|repair`
- workflow dismiss / repair：`/api/workflow-runs/:run_id/sessions/:session_id/dismiss|repair`
- 对外保持现有 API path、payload、status code 与事件语义不变
- provider 错误、runtime failure 事件与 `agent-chat` SSE 对外字段统一使用 snake_case，包括 `next_action`、`raw_status`、`cooldown_until`

## 兼容边界

- provider 仅支持当前正式 provider 集合
- 历史运行时中遗留的非正式终态会先经过一次性迁移再参与当前编排；正式实现不再保留长期读路径兼容分支
- reminder、redispatch、timeout recovery 属于主场景内机制，不单独暴露为独立产品面
