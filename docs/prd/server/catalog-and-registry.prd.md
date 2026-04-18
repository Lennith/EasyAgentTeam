# Catalog 与 Registry PRD（最后更新：2026-04-16）

## 状态

- 文档状态：`实装`

## 目标

Catalog 与 Registry 负责维护 Agent、Skill、Skill List、Team、Agent Template 这些可复用配置实体，为 project 和 workflow 提供配置来源。

## 当前有效能力

- agents：注册、更新、删除、默认模型参数配置
- skills：导入、列出、删除
- skill-lists：增删改查
- teams：增删改查、路由配置、agent model configs
- agent-templates：built-in + custom 模板管理

## 兼容边界

- 已下线 provider 不再允许写入新的 registry 数据
- 模型参数写入时必须通过 provider/model 组合校验
