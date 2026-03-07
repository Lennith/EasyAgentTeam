# MiniMax Agent Loop 模块 PRD

## 1. 模块目标

### 模块职责

MiniMax Agent Loop 模块负责单个 MiniMax 会话内的推理-工具调用执行循环。

**源码路径**:

- `server/src/minimax/agent/Agent.ts`
- `server/src/minimax/llm/LLMClient.ts`

### 解决问题

- 将 LLM 对话与工具调用统一成可控步骤循环
- 在工具协议异常时提供会话内自恢复
- 为 runner 提供稳定、可回调的执行内核

### 业务价值

- 保证 agent 在复杂 tool 场景下可持续推进
- 降低协议错误导致的整轮失败

---

## 2. 功能范围

### 包含能力

- `run()` / `runWithResult()` 主循环
- callback 回调（thinking/tool_call/tool_result/message/error/complete）
- 工具调用执行与 tool message 追加
- 会话消息管理（set/get/reset）
- `tool id not found (2013)` 显式恢复注入

### 不包含能力

- 会话持久化（由 storage 负责）
- 编排调度（由 orchestrator 负责）

---

## 3. 对外行为

### 3.1 输入

| 参数      | 类型          | 必填 | 说明          |
| --------- | ------------- | ---- | ------------- |
| prompt    | string        | 是   | 用户/系统输入 |
| sessionId | string        | 否   | 指定会话      |
| maxSteps  | number        | 否   | 最大循环步数  |
| callback  | AgentCallback | 否   | 运行事件回调  |

### 3.2 输出

- `AgentRunResult`：`content` + `usage`
- 回调事件流（用于 runner 日志和事件写入）

---

## 4. 内部逻辑

### 核心处理规则

1. 追加 user prompt 到消息历史。
2. 调用 `LLMClient.generate(messages, toolSchemas)`。
3. 若返回 tool calls：逐个执行工具并追加 tool message。
4. 若 finish reason 不是 `tool_use`：结束本轮并返回。
5. 超过 `maxSteps` 返回超步信息。

### TOOLCALL_FAILED 恢复

- 捕获 `tool result's tool id ... not found (2013)`：
  - 注入一条 `[TOOLCALL_FAILED]` 用户消息，包含 `missing_tool_call_id`、`matched_tool_name`、`next_action`
  - 第一次继续循环
  - 连续第二次升级失败（抛错）

---

## 5. 依赖关系

### 上游依赖

- `LLMClient`
- `ToolRegistry`

### 下游影响

- `minimax-runner` 的运行结果与恢复事件
- 任务上报和 discuss 工具调用成功率

---

## 6. 约束条件

- 单个 Agent 实例不允许并发 run（`isRunning` 保护）。
- 工具调用必须保持消息顺序一致。
- 当前默认上限：`maxSteps=100`（可由 config 覆盖）。

---

## 7. 异常与边界

| 场景                 | 处理                           |
| -------------------- | ------------------------------ |
| Agent 并发调用       | 抛 `Agent is already running`  |
| 工具执行失败         | 写 tool error 内容，继续循环   |
| 连续 TOOLCALL_FAILED | 第二次升级失败并上抛           |
| 用户取消             | 返回 `Task cancelled by user.` |

---

## 8. 数据定义

### 核心类型

- `AgentRunResult`
- `AgentOptions`
- `AgentCallback`
- `Message` / `ToolCall`

### 关键字段

- `messages[]`：会话上下文
- `consecutiveToolCallProtocolFailures`：协议失败计数器

---

## 9. 待确认问题

- 是否在 agent loop 层增加 context window 主动摘要策略（当前主要在 runner/llm 层处理）。
- TOOLCALL_FAILED 注入内容是否需要项目可配置模板。
