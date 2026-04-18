# 领域模型规范（最后更新：2026-04-16）

## 范围

本规范描述 project / workflow / team 等领域模型的当前职责分区。

## 当前模型簇

- project / task / session / route / message
- workflow template / run / runtime / session / schedule
- catalog agent / skill / skill-list / team / agent-template
- Team 相关模型与路由模型单独成簇，不再混入基础 project models

## 当前要求

- 公共 API 使用稳定字段名
- 持久化字段与对外字段允许存在不同层级，但必须有明确映射
- provider、model、route、task 状态必须使用受控枚举或稳定字面值
