# 调试与 Agent Chat PRD（最后更新：2026-04-16）

## 状态

- 文档状态：`实装`

## 目标

该页面组负责暴露运行中会话、输出和交互入口，帮助确认系统是否按设计推进。

## 当前有效页面

- `#/debug/agent-sessions`：项目级会话列表与时间线观察
- `#/debug/agent-output`：项目级 agent output 查看器
- project workspace `agent-chat`：项目级 agent chat 与中断
- workflow run workspace `agent-chat`：workflow 级 agent chat 与中断
- workflow run workspace `chat`：workflow timeline 只读观察

## 当前有效能力

- 基于项目选择器查看 session 和 agent IO timeline
- 查看项目级 JSONL 输出聚合结果
- 对当前可见 session 发起 agent chat
- 在 project 或 workflow 范围中中断当前 chat

## 非目标

- `#/debug` 不承担 workflow 级调试页职责
- 不单独提供 workflow session 日志浏览器
- 不在前端推导 session 或 task 的终态
