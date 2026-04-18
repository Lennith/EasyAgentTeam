# 2026-04-19 Release Note（最后更新：2026-04-19）

## 摘要

本次发布收口了近期的编排器与文档治理大改动，重点是删除已退役接口和暧昧状态、统一 provider 失败恢复语义、修复 workflow mixed baseline 的行为型 telemetry 回归，并将正式文档收敛到根 `docs/` 目录。

## 主要变更

### 编排器与任务状态

- 删除 project 侧已退役接口，不再保留兼容 stub。
- 删除 `MAY_BE_DONE` 状态及其相关协议、前端类型、自动打标、提醒与 redispatch 逻辑。
- 历史落盘 `MAY_BE_DONE` 数据按读路径统一归一为 `DONE`。
- 收紧 project/workflow reminder 与子树收敛规则，避免祖先任务抢占未收敛后代的处理时机。

### Provider 运行时

- 补齐 Codex workflow session 行为，保证真实 `providerSessionId` 在 `thread_started` 后及时写回 authoritative session。
- MiniMax 暂态错误统一归类为可恢复运行时错误，覆盖 `429`、`500/502/503/504/529`、连接超时与连接重置。
- MiniMax 暂态错误统一采用 `idle + cooldown` 恢复策略，不再直接落成 `dismissed`。
- 新增独立 transient cooldown 配置：`SESSION_TRANSIENT_ERROR_COOLDOWN_MS`，默认 30 秒。

### Workflow 行为与 Telemetry

- 修正 workflow mixed baseline 下的任务分解行为：
  - `rd_lead` 必须先创建可执行子任务后再完成工程分解。
  - 非分解角色默认直接执行，不再继续自拆子任务。
  - 工程分解阶段不再提前创建 QA/Release 等未来 phase 子任务。
- `pnpm e2e:workflow` 与 `pnpm e2e:baseline` 恢复全绿。

### Failure Transition 与事件 Schema

- 新增统一 runner failure transition policy，project 与 workflow 共用同一套失败落态决策。
- 对外 runtime event、SSE error、provider payload 字段统一收口到 snake_case。
- `next_action`、`raw_status` 成为统一外部字段名，不再混用 camelCase。

### 文档治理

- 正式文档统一迁移到根 `docs/`，按 `guide / prd / spec / logic / ops` 分层。
- 删除历史计划、技术债、重复 TeamTool 文档和运行产物文档，不做归档。
- 更新 `5 分钟上手` 路径，统一改为项目专用建项目 Agent 入口。

## 关键提交

- `522f08b` feat: converge orchestrator cleanup and transient recovery
- `4741206` refactor: converge workflow telemetry and runner failures

## 验证结论

- workflow telemetry 已按行为修复，不是通过放宽统计口径收绿。
- `pnpm e2e:workflow` 通过。
- `pnpm e2e:baseline` 通过。

## 对使用方的影响

- 任何仍依赖已退役 project 接口或 `MAY_BE_DONE` 状态的外部调用方都需要同步移除旧用法。
- 观察 runtime error/SSE/event 时，应统一读取 snake_case 字段。
- MiniMax 暂态上游错误现在会表现为“会话冷却后重试”，而不是直接终止。
