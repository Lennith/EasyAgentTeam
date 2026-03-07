# 时间线模块 PRD

## 1. 模块目标

模块职责：
提供统一的时间线展示功能，用于可视化展示聊天消息历史和系统事件记录。

解决问题：

- 用户无法直观查看会话过程中的消息流转记录
- 开发者无法追踪系统事件的执行轨迹
- 需要区分不同类型的消息和事件并进行可视化展示

业务价值：

- 提升用户对会话过程的透明度
- 支持调试和问题排查
- 提供消息和事件的时序展示能力

## 2. 功能范围

包含能力：

- ChatTimelineView：聊天消息时间线展示
  - 用户消息（user_message）展示
  - 消息路由记录（message_routed）展示
  - 任务分发记录（dispatch_started）展示
  - 讨论内容（task_discuss）展示
  - 按消息类型着色区分
  - 显示发送者、接收者、内容、状态、运行ID

- EventTimelineView：系统事件时间线展示
  - 事件类型（eventType）展示
  - 事件来源（source）展示
  - 会话ID（sessionId）展示
  - 事件载荷（payload）JSON展示
  - 展示最近100条事件记录

不包含能力：

- 实时推送更新（TODO需确认是否需要）
- 事件过滤和搜索功能（TODO需确认是否需要）
- 消息编辑和删除功能

## 3. 对外行为

### 3.1 输入

来源：

- 父组件通过props传入

参数：

- ChatTimelineView：
  - timeline: AgentIOTimelineItem[] - 时间线数据数组
- EventTimelineView：
  - events: EventRecord[] - 事件记录数组

约束：

- timeline数组中的每项需包含id、createdAt字段
- events数组中的每项需包含eventId、createdAt、eventType字段

### 3.2 输出

结果：

- 渲染时间线视图组件

触发条件：

- 父组件渲染该视图时触发

## 4. 内部逻辑

核心处理规则：

- ChatTimelineView：
  - 过滤timeline数据，仅显示指定类型的消息（user_message、message_routed、dispatch_started、task_discuss）
  - 根据kind类型映射对应颜色和标签
  - 格式化消息内容、时间戳、状态信息
- EventTimelineView：
  - 获取events数组并倒序排列
  - 仅展示最近100条记录
  - 格式化事件类型、时间戳、载荷信息

状态变化：

- 无状态组件，纯展示逻辑

## 5. 依赖关系

上游依赖：

- types/index.ts：AgentIOTimelineItem、EventRecord类型定义
- hooks/i18n：国际化翻译函数

下游影响：

- 被页面组件引用（如AgentChatView等）
- 无下游组件依赖

## 6. 约束条件

技术约束：

- React函数组件
- 使用CSS-in-JS内联样式
- 依赖国际化hook获取翻译文本

性能要求：

- EventTimelineView默认仅渲染100条记录，避免大数据量性能问题

## 7. 异常与边界

异常处理：

- 数据为空时显示empty-state组件
- timeline数据缺少必要字段时使用可选链和默认值

边界情况：

- timeline数组为空：显示"暂无数据"提示
- events数组为空：显示"暂无数据"提示
- 内容过长：使用white-space: pre-wrap和wordBreak: break-word处理

## 8. 数据定义

关键数据：

- AgentIOTimelineItem：
  - id: string - 唯一标识
  - messageType: string - 消息类型
  - createdAt: Date - 创建时间
  - summary: string - 摘要
- EventRecord：
  - eventId: string - 事件唯一标识
  - eventType: string - 事件类型
  - source: string - 事件来源
  - sessionId: string - 会话ID
  - payload: Record<string, unknown> - 事件载荷
  - createdAt: Date - 创建时间

生命周期：

- 数据由父组件通过props传递
- 组件内部无数据持久化需求
- 每次父组件重新渲染时重新接收props

## 9. 待确认问题

TODO 列表：

- [ ] 是否需要支持实时推送更新？
- [ ] 是否需要增加事件过滤和搜索功能？
- [ ] 消息类型是否可能扩展？扩展时如何处理颜色和标签映射？
- [ ] 是否需要支持自定义每页显示数量（当前EventTimeline固定100条）？
- [ ] 是否需要导出功能（如导出为JSON/CSV）？
