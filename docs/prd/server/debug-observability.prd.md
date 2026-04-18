# 调试与可观测性 PRD（最后更新：2026-04-16）

## 状态

- 文档状态：`实装`

## 目标

调试与可观测性能力负责把 Agent 运行过程、时间线、事件、审计输出与性能证据暴露给 dashboard、E2E 和维护者。

## 当前有效能力

- project timeline
- workflow timeline
- project events 查询
- project agent output 查询
- project / workflow agent chat 与 interrupt
- workflow perf trace 审计
- workflow provider observation 审计

## 明确不在当前公开面中的能力

- 没有独立的 workflow `/events` API
- 没有独立的 workflow `agent-output` API
- 没有独立的 debug session 查询 API

## 公开语义

- timeline 与 project events 作为观察视图，不改变业务状态
- workflow provider observation 与 perf trace 属于审计证据，不改变公开 API 行为
