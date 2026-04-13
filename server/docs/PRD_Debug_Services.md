# 调试与时间线模块 PRD

## 1. 模块目标

### 模块状态

- `实装`

### 模块职责

调试与时间线模块负责把后端运行事件转换为可分析输出，覆盖：

- 事件流到时间线的结构化映射
- Agent 运行输出日志的聚合与解析
- 任务生命周期回放（task detail 生命周期）
- workflow 内部慢 API 分析用的 opt-in perf trace

**源码路径**:

- `server/src/services/agent-io-timeline-core.ts`
- `server/src/services/agent-io-timeline-service.ts`
- `server/src/services/workflow-agent-io-timeline-service.ts`
- `server/src/services/agent-debug-service.ts`
- `server/src/services/agent-chat-service.ts`
- `server/src/services/task-detail-query-service.ts`
- `server/src/services/workflow-perf-trace.ts`
- `server/src/routes/workflow-routes.ts`
- `server/src/data/repository/workflow/run-repository.ts`
- `server/src/data/repository/workflow/runtime-repository.ts`
- `server/src/services/orchestrator/workflow/workflow-runtime-support-service.ts`
- `server/src/services/orchestrator/workflow/workflow-run-query-service.ts`
- `server/src/services/orchestrator/workflow/workflow-dispatch-service.ts`

### 解决问题

- 让 dispatch / message / task action 的执行过程可追溯
- 快速定位失败原因（路由拒绝、状态冲突、report 拒绝）
- 为 Dashboard 和离线排查提供统一数据形态

### 业务价值

- 降低线上协作问题排查成本
- 提高任务闭环与状态解释能力

---

## 2. 功能范围

### 包含能力

- `GET /api/projects/:id/agent-io/timeline`
- `GET /api/projects/:id/events`
- `GET /api/projects/:id/tasks/:task_id/detail`
- `POST /api/projects/:id/agent-chat`
- `POST /api/projects/:id/agent-chat/:sessionId/interrupt`
- 内部 run log 解析（`buildAgentRunDetails`）
- workflow opt-in perf trace（仅内部审计文件，不新增对外 API）

### 不包含能力

- 事件写入（由 event-store 与业务服务负责）
- 任务状态计算（由 taskboard 与 task-action 负责）

---

## 3. 对外行为

### 3.1 输入

#### timeline 查询

| 参数  | 类型   | 必填 | 说明                   |
| ----- | ------ | ---- | ---------------------- |
| limit | number | 否   | 限制返回条数，默认全量 |

#### agent chat

| 参数              | 类型   | 必填 | 说明                |
| ----------------- | ------ | ---- | ------------------- |
| role              | string | 是   | 目标角色            |
| prompt            | string | 是   | 用户输入            |
| sessionId         | string | 否   | 指定会话            |
| providerSessionId | string | 否   | provider 侧会话引用 |

#### task detail 查询

| 参数    | 类型   | 必填 | 说明     |
| ------- | ------ | ---- | -------- |
| task_id | string | 是   | 目标任务 |

### 3.2 输出

#### Timeline item（核心）

- `kind`: `user_message` / `message_routed` / `task_action` / `task_discuss` / `task_report` / `dispatch_*`
- `from` / `toRole` / `toSessionId`
- `requestId` / `messageId`
- `discussThreadId`

#### Agent chat stream（核心）

- SSE `event:data` 流式返回
- 支持 `thinking/tool_call/tool_result/message/complete/error/step` 事件类型

#### Task detail（核心）

- 任务静态信息（owner/creator/state/dependencies）
- `lifecycle[]`（从 events 过滤该 task 的事件回放）

---

## 4. 内部逻辑

### 核心处理规则

1. project 与 workflow timeline 都通过 `agent-io-timeline-core.ts` 的同一条 event-to-row 主路径执行。
2. 两个 facade 只保留事件读取差异：
   - project：读取 project events
   - workflow：读取 workflow run events
3. `TASK_ACTION_REJECTED` 在 timeline 中保留 `error_code` 与 `next_action`。
4. `TASK_REPORT_APPLIED` 在 timeline 中归类为 `task_report`。
5. `MESSAGE_ROUTED` 且 messageType 以 `TASK_DISCUSS` 开头时归类为 `task_discuss`。
6. workflow dispatch 行在 `requestedSkillIds` 存在时继续写入 `content` 摘要；project timeline 不追加该字段。
7. 全部项按 `createdAt` 排序，再按 `limit` 截断。
8. 当 `WORKFLOW_PERF_TRACE=1` 时，workflow 相关热点路径追加内部 perf trace：
   - 已覆盖的 route handler 热点段：
     - `POST /api/workflow-runs`
     - `POST /api/workflow-runs/:run_id/sessions`
     - `GET /api/workflow-runs/:run_id/task-runtime`
     - `GET /api/workflow-runs/:run_id/task-tree-runtime`
     - `PATCH /api/workflow-runs/:run_id/orchestrator/settings`
     - `POST /api/workflow-runs/:run_id/orchestrator/dispatch`
   - `workflowRuns.createRun / patchRun / readRuntime`
   - `sessions.listSessions / upsertSession / touchSession`
   - `ensureRuntime`
   - `buildWorkflowRuntimeSnapshot`
   - `buildWorkflowTaskTreeView`
   - `dispatchRun`
9. workflow perf trace 只写入 `data/workflows/runs/<runId>/audit/perf_trace.jsonl`，不改变任何 public API path、payload、status code。
10. 当前 perf trace 仅提供按 run 聚合的 span 样本，不提供逐请求 `trace_id` / `parent_span_id` 级联；route 到 service/repo 的对应关系用于热点归因，不用于严格请求树还原。
11. `workflow_perf_summary.json` 与 `workflow_perf_report.md` 属于 E2E 观察脚本对原始 trace 的离线导出产物，不是后端直接写出的 API 或审计文件。
12. 当前未覆盖的 workflow 慢 API / repo blind spots 仍包括：

- `GET /api/workflow-runs`
- `GET /api/workflow-runs/:run_id`
- `GET /api/workflow-runs/:run_id/status`
- `GET /api/workflow-runs/:run_id/task-tree`
- `GET /api/workflow-runs/:run_id/sessions`
- `GET /api/workflow-runs/:run_id/agent-io/timeline`
- `POST /api/workflow-runs/:run_id/agent-chat`
- `listWorkflowRuns`
- `getWorkflowRun`
- `writeWorkflowRunTaskRuntimeState`
- `appendWorkflowRunEvent`
- `listWorkflowRunEvents`

### run log 解析（内部）

- `agent_output.jsonl` 按 runId 聚合
- 识别 tool call / tool output / error / token usage
- Codex MCP 的 tool_result 必须优先解析 `structuredContent`，回退解析 `content[0].text`，避免把 TeamTool 错误退化成不可读数组字符串
- provider 启动配置错误必须在 debug / timeline / agent chat 错误流中保持同一语义：
  - `code`
  - `message`
  - `next_action`
  - 可选 `details`
- `ORCHESTRATOR_DISPATCH_FAILED` 的错误摘要必须可稳定追溯到 provider launch error，不再只暴露裸的 `Unknown model` 或 `exitCode=1`
- 后端仅保留原始 trace / event / output 审计文件；`workflow_perf_summary.json`、`workflow_perf_report.md`、run summary 等聚合型产物由 E2E 观察脚本离线导出，不作为后端直接写出的调试文件

---

## 5. 依赖关系

### 上游依赖

- `event-store`（事件读取）
- `taskboard-store`（task 快照）
- `agent_output.jsonl`（run 输出）

### 下游影响

- Dashboard timeline / task detail 视图
- E2E 回放与故障分析脚本

---

## 6. 约束条件

- 时间线只反映事件事实，不做业务状态二次推断。
- 解析服务不改写源事件，仅做读取与映射。

---

## 7. 异常与边界

| 场景             | 处理                 |
| ---------------- | -------------------- |
| event 文件不存在 | 返回空列表           |
| task 不存在      | `404 TASK_NOT_FOUND` |
| limit 非法       | 按接口层校验返回 400 |

---

## 8. 数据定义

### 核心类型

- `AgentIOTimelineItem`
- `TaskDetailResponse`
- `DebugAgentRunDetail`

### 关键字段

- `discussThreadId`：discuss 线程标识
- `status`：dispatch 或 task action 的摘要状态
- `lifecycle.event_type`：任务生命周期事件名

---

## 9. 待确认问题

- 是否增加按 role 过滤 timeline 的后端参数。
- run log 解析是否独立对外 API（当前为内部能力）。
