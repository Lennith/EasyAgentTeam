# 数据存储规范（最后更新：2026-04-16）

## 范围

本规范描述后端数据目录、repository 边界、运行态持久化和读写职责。

## 当前边界

- 路由层不直接操作持久化
- 应用服务负责 `UnitOfWork` 和 repository 组合
- project 与 workflow 使用各自的 runtime / repository bundle
- 调试与 perf trace 产物属于审计数据，不改写业务契约

## 当前存储主题

- project runtime
- workflow run / runtime / sessions
- catalog entities
- runtime settings
- locks 与消息
