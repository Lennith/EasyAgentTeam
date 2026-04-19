# 项目工作区 PRD（最后更新：2026-04-19）

## 状态

- 文档状态：`实装`

## 目标

项目工作区负责展示项目级任务推进、会话状态、时间线、路由和调试入口，是 project 模式的主要前端工作面。

## 当前有效能力

- 打开项目工作区并切换 task tree、timeline、sessions、routing、locks 等视图
- 项目工作区提供 scoped Recovery 视图，用于查看当前项目内待恢复 session、最近失败、cooldown 与恢复动作
- 发送 agent chat 与中断当前会话
- 查看任务细节、时间线、事件和 session 状态

## 非目标

- 不在前端直接实现编排决策
- 不在前端直接维护 provider 协议细节
