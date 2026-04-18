# Agent 与 Skill 页面组 PRD（最后更新：2026-04-16）

## 状态

- 文档状态：`实装`

## 目标

该页面组负责维护可复用的 agent、agent template、skill、skill list，并为团队与项目配置提供可选素材。

## 当前有效页面

- agent sessions：按项目查看会话列表
- agent registry：创建和编辑 agent 定义
- agent templates：查看内置模板、维护自定义模板
- skill library：导入和删除 skill
- skill lists：维护 skill list

## 当前有效能力

- agent 的显示名、prompt、summary、skill list 和默认 CLI 工具覆盖
- agent template 的新建、复制、编辑、删除
- skill 的本地导入、递归发现、删除
- skill list 的显示名、说明、`include_all` 和显式 skill 选择

## 非目标

- 不在当前 UI 编辑 agent 默认模型参数
- 不在当前 UI 实现 session 级运行控制
- 不在前端定义 skill 注入、provider 兼容和模型选择规则
