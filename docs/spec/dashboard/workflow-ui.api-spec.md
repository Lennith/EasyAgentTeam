# Workflow UI 规范（最后更新：2026-04-23）

## 页面范围

- `#/workflow`
- `#/workflow/runs/new`
- `#/workflow/runs/:run_id/:view`
- `#/workflow/templates`
- `#/workflow/templates/new`
- `#/workflow/templates/:template_id/edit`

## Template 列表与编辑器消费

- `GET /api/workflow-templates`
- `GET /api/workflow-templates/:template_id`
- `POST /api/workflow-templates`
- `PATCH /api/workflow-templates/:template_id`
- `DELETE /api/workflow-templates/:template_id`

## Run 列表与新建向导消费

- `GET /api/workflow-runs`
- `POST /api/workflow-runs`
- `POST /api/workflow-runs/:run_id/start`
- `POST /api/workflow-runs/:run_id/stop`
- `GET /api/workflow-orchestrator/status`

## Run 工作区消费

- `GET /api/workflow-runs/:run_id`
- `GET /api/workflow-runs/:run_id/status`
- `GET /api/workflow-runs/:run_id/task-tree-runtime`
- `GET /api/workflow-runs/:run_id/sessions`
- `GET /api/workflow-runs/:run_id/runtime-recovery?attempt_limit=5`
- `GET /api/workflow-runs/:run_id/agent-io/timeline`
- `GET /api/workflow-runs/:run_id/orchestrator/settings`
- `PATCH /api/workflow-runs/:run_id/orchestrator/settings`
- `POST /api/workflow-runs/:run_id/orchestrator/dispatch`
- `POST /api/workflow-runs/:run_id/sessions/:session_id/dismiss`
- `POST /api/workflow-runs/:run_id/sessions/:session_id/repair`
- `POST /api/workflow-runs/:run_id/sessions/:session_id/retry-dispatch`
- `GET /api/workflow-templates/:template_id`
- `POST /api/workflow-runs/:run_id/agent-chat`
- `POST /api/workflow-runs/:run_id/agent-chat/:session_id/interrupt`

## 页面职责映射

- templates：模板列表、搜索、删除、跳转到编辑器或新建 run
- new-run：选择模板、填写工作区、填写变量和运行策略
- runs：run 列表、start/stop、跳转到 run 工作区
- run workspace overview：run 元数据、orchestrator 状态、运行策略回显与编辑
- run workspace task-tree：基于 task tree runtime 的树视图
- run workspace chat：timeline 只读观察
- run workspace agent-chat：对单个会话发起聊天和中断
- run workspace team-config：以模板快照展示 route matrix 与 discuss rounds
- run workspace recovery：按当前 run 聚合需恢复 session、最近 failure、cooldown、dismiss/repair 动作与最近恢复审计片段；默认请求有限条 `recovery_attempts`，避免长历史无界渲染
- run workspace recovery：高风险动作必须根据 `requires_confirmation` 显式提交 `confirm: true`，并直接展示 `disabled_reason / risk / latest_events`
- run workspace recovery：retry-dispatch 必须直接回填后端返回的 `expected_*` failure context guard 字段，不自行拼装 retry 条件

## 明确不属于当前工作区主契约的能力

- 不把所有 workflow 后端接口都视为前端页面契约
- 不在页面直接消费 task runtime 全量快照
- 不在页面直接调用 task detail、task actions、messages send、sessions register 作为默认工作流
- Recovery 动作由后端 policy 决定，前端只展示 `can_* / disabled_reason / risk / requires_confirmation`
