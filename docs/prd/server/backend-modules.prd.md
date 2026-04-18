# 后端模块总览 PRD（最后更新：2026-04-16）

## 状态

- 文档状态：`实装`
- 适用范围：`server/src/**`

## 当前正式模块

- 编排运行时：project / workflow orchestrator、dispatch、reminder、session lifecycle
- 任务协议：task-tree、task detail、task-actions、讨论与终态上报
- Workflow Runtime：template、run、session、runtime 查询与调度
- Catalog 与 Registry：agents、skills、skill-lists、teams、agent-templates
- Runtime Settings 与 System API：settings、models、project-templates、prompt、healthz
- Debug 与 Observability：timeline、agent-chat、events、perf trace
- 数据与持久化：repositories、runtime state、locks、catalog 存储

## 文档分工

- PRD：当前有效能力、公开语义、兼容边界
- SPEC：接口、数据契约、协议与实现边界
- Logic：决策逻辑、状态流转、异常恢复

## 子主题边界

- 编排运行时、任务协议、workflow runtime、runtime settings、catalog、debug 分别在同目录的专门 PRD 中展开。
- 具体接口、数据结构和逻辑状态机分别下沉到 `docs/spec/server/` 和 `docs/logic/server/`。
