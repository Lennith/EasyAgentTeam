# Routing Config PRD

## 状态

- `实装`

## 目标

Routing Config 模块负责编辑项目内多 Agent 的通信路由、任务分配路由、讨论轮次，以及每个 Agent 的 provider/model/effort 配置。

## 当前有效能力

- 编辑 `agent_ids`
- 编辑 `route_table`
- 编辑 `task_assign_route_table`
- 编辑 `route_discuss_rounds`
- 编辑 `agent_model_configs`

其中 `agent_model_configs` 当前只允许：

- `provider_id: "codex" | "minimax"`
- `model: string`
- `effort?: "low" | "medium" | "high"`

## 当前有效约束

- 新写入配置不再接受已下线 provider
- 旧数据中遗留的已下线 provider 在读取时统一归一化为 `minimax`
- 未显式配置 provider 的 Agent 默认使用 `minimax`
- 任务分配路由必须是通信路由的子集

## UI 行为

- provider 下拉只展示 `Codex` 与 `MiniMax`
- provider 切换后，模型列表按当前 provider 过滤
- 保存时前端仅提交双 provider 枚举，不提交已下线 provider
- 加载旧项目时，如果后端已归一化为 `minimax`，界面直接展示 `MiniMax`
