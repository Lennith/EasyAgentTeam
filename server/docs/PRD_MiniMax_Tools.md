# MiniMax Tools 模块 PRD

## 模块状态

- `实装`

## 1. 模块目标

### 模块职责

MiniMax Tools 模块为 MiniMax Agent 提供可调用工具集合，并通过“能力族去重 + 权限管理 + 服务直连桥接”保证稳定协作。

**源码路径**:

- `server/src/minimax/tools/**`
- `server/src/minimax/tools/team/**`
- `server/src/minimax/tools/tool-registration.ts`
- `server/src/services/minimax-teamtool-bridge.ts`

### 解决问题

- 避免脚本参数复杂导致的高失败率
- 将 task/discuss/lock 直接桥接后端服务，减少 HTTP+脚本噪音
- 避免重复工具注册带来的冲突和无效调用

### 业务价值

- 提高 MiniMax 协作稳定性
- 降低错误恢复成本
- 增强工具链可观测性

---

## 2. 功能范围

### 包含能力

#### 2.1 Core Tools

- `read_file`
- `write_file`
- `edit_file`
- `glob`
- `grep`
- `web_fetch`
- `web_search`
- `shell_execute`
- `session_note`
- `summary_messages`

> 默认注册中已移除 `list_directory`，用于减少高噪音无效探索。

#### 2.2 Team Tools（直连后端服务）

- `task_create_assign`
- `task_report_in_progress`
- `task_report_done`
- `task_report_block`
- `discuss_request`
- `discuss_reply`
- `discuss_close`
- `route_targets_get`
- `lock_manage`

#### 2.3 能力族去重

按 capability family 保留唯一生效工具，优先级：`team > core > other`。

### 不包含能力

- Codex/Trae 工具注册逻辑（本模块仅 MiniMax）
- 前端工具面板展示逻辑

---

## 3. 对外行为

### 3.1 输入

#### 来源

- MiniMax Agent ToolCall

#### 工具执行上下文

- `projectId`
- `agentRole`
- `sessionId`
- `activeTaskId`
- `activeParentTaskId`
- `activeRootTaskId`
- `parentRequestId`
- `summary_messages` 上下文桥接（checkpoint 查询与 apply 请求登记）

### 3.2 输出

- 标准 ToolResult
- 失败时统一错误结构：
  - `error_code`
  - `message`
  - `next_action`
  - `raw`

#### 3.3 `summary_messages` 工具协议

输入参数：

- `action`: `list | apply`
- `checkpoint_id`: `string`（`apply` 必填）
- `summary`: `string`（`apply` 必填）
- `keep_recent_messages`: `number`（可选，默认 `0`，范围 `0~20`）

行为规则：

- `list`：返回当前 session 的可用 checkpoint 列表（倒序，最多 50 条）。
- `apply`：只登记一次待应用请求，不在工具执行函数中直接改写对话消息。
- 待应用请求由 `Agent` 在单轮工具调用批次结束后统一执行，避免破坏 tool_call/tool_result 协议配对。

错误码：

- `CHECKPOINT_NOT_FOUND`
- `SUMMARY_EMPTY`
- `INVALID_KEEP_RECENT_MESSAGES`
- `SUMMARY_APPLY_NOT_AVAILABLE`

---

## 4. 内部逻辑

### 核心处理规则

#### 4.1 工具注册

- 启动时注册 Team Tools + Core Tools。
- 同名重复或同能力族冲突时，跳过低优先级工具并记录观测信息。

#### 4.2 TeamTool Bridge

`minimax-teamtool-bridge` 直接调用后端 service：

- task: `handleTaskAction(...)`
- message: `handleManagerMessageSend(...)`
- route snapshot: `buildProjectRoutingSnapshot(...)`
- lock: `acquire/renew/release/list`

#### 4.3 错误映射

将 service 错误转换为可执行提示（next_action），避免模型盲重试。

#### 4.4 Checkpoint 与消息压缩应用

- 自动打点规则：
  - 用户输入消息：打 `user_prompt` checkpoint
  - assistant 发起 tool_calls：打 `assistant_toolcall` checkpoint
  - summary 锚点消息：打 `summary_anchor` checkpoint
- `summary_messages.apply` 执行时机：当前 tool batch 结束后统一应用。
- 改写结果规则：保留系统消息 + checkpoint 之前有效历史 + 可选最近 N 条 + summary anchor。
- apply 过程中要求保持协议一致性，不允许生成 orphan tool_result。

---

## 5. 依赖关系

### 上游依赖

- `task-action-service`
- `manager-message-service`
- `project-routing-snapshot-service`
- `lock-store`

### 下游影响

- `minimax/agent/Agent.ts` 工具调用成功率与上下文质量
- 编排器事件链（TEAM_TOOL_CALLED/SUCCEEDED/FAILED）

---

## 6. 约束条件

- MiniMax 文件权限基于项目目录白名单。
- Team Tools 必须在有效执行上下文下运行（缺 task 上下文需显式报错）。
- 工具注册必须通过去重策略，避免功能重复。
- `summary_messages` 默认全环境启用；紧急熔断由环境变量 `AUTO_DEV_SUMMARY_MESSAGES_DISABLE=1` 控制。

---

## 7. 异常与边界

| 场景               | 处理                                       |
| ------------------ | ------------------------------------------ |
| task 上报目标非法  | `TASK_RESULT_INVALID_TARGET` + next_action |
| progress 校验失败  | `TASK_PROGRESS_REQUIRED` + next_action     |
| lock 非 owner 操作 | `LOCK_NOT_OWNER`                           |
| capability 冲突    | 跳过低优先级工具                           |

---

## 8. 数据定义

### 核心类型

- `TeamToolExecutionContext`
- `TeamToolBridge`
- `ToolRegistrationState`
- `ToolRegistrationResult`

### 关键观测事件

- `TEAM_TOOL_CALLED`
- `TEAM_TOOL_SUCCEEDED`
- `TEAM_TOOL_FAILED`
- `MINIMAX_TOOL_REGISTRATION_SKIPPED_DUPLICATE`
- `SUMMARY_MESSAGES_APPLY_ACCEPTED`
- `SUMMARY_MESSAGES_APPLIED`

---

## 9. 待确认问题

- 是否增加按项目级开关控制某些高风险工具（如 shell）。
- team tool 错误提示是否需要多语言化。
