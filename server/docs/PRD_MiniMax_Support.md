# MiniMax 支撑模块 PRD

## 1. 模块目标

### 模块状态

- `实装`

### 模块职责

MiniMax 支撑模块负责把编排器 dispatch 请求转换为可执行的 MiniMax run，并处理运行期恢复、日志与事件闭环。

**源码路径**:

- `server/src/services/minimax-runner.ts`
- `server/src/minimax/index.ts`
- `server/src/minimax/storage/**`
- `server/src/minimax/compression/**`
- `server/src/services/minimax-teamtool-bridge-core.ts`
- `server/src/services/minimax-teamtool-bridge.ts`
- `server/src/services/workflow-minimax-teamtool-bridge.ts`

### 解决问题

- 统一 MiniMax 运行入口和上下文注入
- 处理模型协议错误与上下文超限恢复
- 产出可观测日志与事件

### 业务价值

- 提升 MiniMax 运行稳定性
- 降低因 provider 异常导致的流程中断

---

## 2. 功能范围

### 包含能力

- run 生命周期事件：`MINIMAX_RUN_STARTED/FINISHED/FAILED`
- 心跳更新与 wakeup 回调
- Team Tool Bridge 直连 task/message/lock/route
- context window exceeded 恢复重试
- toolcall protocol failed 注入与升级
- 会话持久化与消息压缩

### 不包含能力

- 调度策略（由 orchestrator 负责）
- 前端展示层

---

## 3. 对外行为

### 3.1 输入

`MiniMaxRunRequest` 关键字段：

- `sessionId`
- `prompt`
- `taskId`
- `agentRole`
- `parentRequestId`
- `activeTaskTitle/activeParentTaskId/activeRootTaskId/activeRequestId`

### 3.2 输出

`MiniMaxRunResultInternal`：

- `runId`
- `startedAt/finishedAt`
- `exitCode/timedOut`
- `logFile`
- `sessionId`

---

## 4. 内部逻辑

### 核心处理规则

1. 创建 MiniMaxAgent，注入 workspace、sessionDir、model、tokenLimit、shell 参数。
2. TeamToolBridge 统一走 `minimax-teamtool-bridge-core.ts` 的共享骨架：
   - `TeamToolBridgeError`
   - lock acquire / renew / release / list
   - 通用输入读取与错误转换骨架
3. project / workflow bridge 只保留各自的 task action、message、route target 语义与 payload 映射。
4. 注入 TeamToolExecutionContext + TeamToolBridge（直连后端 service）。
5. 注入运行时环境变量（`AUTO_DEV_ACTIVE_TASK_*` 等）。
6. 运行中周期性 heartbeat 更新 `lastActiveAt`。
7. 结束后写 run finished 事件并触发 completion callback。

### 恢复策略

#### context window exceeded

- 命中超限后注入 `[CONTEXT_WINDOW_RECOVERY]` 简短提示，重试一次。
- 成功写 `MINIMAX_CONTEXT_WINDOW_RECOVERED`，失败进入失败闭环。

#### toolcall 协议错误（2013）

- Agent 内先注入 `[TOOLCALL_FAILED]` 消息继续一轮。
- 连续失败升级，runner 记录 `MINIMAX_TOOLCALL_FAILED_ESCALATED` 并失败收口。

---

## 5. 依赖关系

### 上游依赖

- `runtime-settings-store`
- `session-store`
- `event-store`

### 下游影响

- orchestrator dispatch 成功率
- timeline/events 诊断质量

---

## 6. 约束条件

- 当前平台按 Windows 运行（shell 以 PowerShell 为主）。
- sessionDir 默认 `.minimax/sessions`（可配置覆盖）。
- 恢复重试有限次，避免无限循环。

---

## 7. 异常与边界

| 场景                | 处理                    |
| ------------------- | ----------------------- |
| API key 缺失        | 直接失败并写错误日志    |
| 模型调用失败        | 写 `MINIMAX_RUN_FAILED` |
| context window 超限 | 触发一次恢复重试        |
| 工具协议连续失败    | 升级失败并收口          |

---

## 8. 数据定义

### 核心类型

- `MiniMaxRunRequest`
- `MiniMaxRunResultInternal`
- `RuntimeSettings`
- `TeamToolExecutionContext`

### 关键事件

- `MINIMAX_RUN_STARTED`
- `MINIMAX_RUN_FINISHED`
- `MINIMAX_RUN_FAILED`
- `MINIMAX_CONTEXT_WINDOW_EXCEEDED`
- `MINIMAX_CONTEXT_WINDOW_RECOVERED`
- `MINIMAX_TOOLCALL_FAILED_INJECTED`
- `MINIMAX_TOOLCALL_FAILED_ESCALATED`

---

## 9. 待确认问题

- 是否引入项目级 MiniMax 重试策略开关（当前全局行为）。
- context window 恢复提示是否需要可配置模板。
