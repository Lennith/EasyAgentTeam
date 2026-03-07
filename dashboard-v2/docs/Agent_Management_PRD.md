# Agent管理模块 PRD

## 1. 模块目标

### 模块职责

Agent管理模块是dashboard-v2前端系统中的核心模块，负责管理和监控AI Agent的全生命周期。该模块提供Agent注册、模板管理、实时对话、消息IO监控、日志查看和会话管理等功能。

### 解决问题

- 用户无法直观管理项目中注册的AI Agent
- 缺乏Agent模板的创建、编辑和复用机制
- 无法与Agent进行实时交互和对话
- 缺少Agent消息传递的可视化监控
- 无法查看Agent执行过程中的日志输出
- 缺乏对Agent会话状态的全面了解

### 业务价值

- 提供统一的Agent管理界面，降低运维成本
- 通过模板机制提升Agent创建的效率
- 实时的消息和日志监控便于问题排查
- 会话管理功能保障Agent服务的稳定性

---

## 2. 功能范围

### 包含能力

#### 2.1 Agent注册管理 (AgentRegistryView)

- 列出项目中所有已注册的Agent
- 创建新Agent（指定agentId、displayName、prompt、defaultCliTool）
- 编辑已有Agent的配置信息
- 删除Agent
- 从现有Agent复制创建新Agent
- 支持从模板应用快速创建Agent
- 默认CLI工具配置（codex/trae/minimax）

#### 2.2 Agent模板管理 (AgentTemplatesView)

- 列出系统内置模板（built-in）
- 列出用户自定义模板（custom）
- 创建新模板
- 编辑自定义模板
- 删除自定义模板
- 从内置模板或自定义模板复制创建新模板

#### 2.3 Agent实时对话 (AgentChatView)

- 按角色（role）分组展示Agent会话
- 选择指定会话进行对话
- 实时流式响应展示（thinking、tool_call、tool_result）
- 发送中断请求
- 展示执行步骤进度（step/maxSteps）
- 展示完成原因（finishReason）

#### 2.4 Agent消息IO监控 (AgentIOView)

- 时间线形式展示Agent消息流转
- 消息类型过滤（user_message、message_routed、task_action等）
- 消息详情展开查看（content、messageType、requestId等）
- 向指定Agent发送消息
- 支持多种消息类型（MANAGER_MESSAGE、TASK_DISCUSS系列）

#### 2.5 Agent日志查看 (AgentLogView)

- 按项目查看Agent日志
- 多会话日志聚合展示
- 按流类型分类（stdout、stderr、system、response）
- 日志时间窗口自动合并
- diff代码块高亮展示
- 实时刷新/暂停控制
- 日志量统计

#### 2.6 Agent会话管理 (AgentSessionsView)

- 按项目查看所有Agent会话
- 会话列表展示（sessionId、role、status、currentTaskId等）
- 会话状态筛选（running、idle等）
- 会话创建时间和心跳时间展示

### 不包含能力

- Agent后端服务部署和管理
- Agent性能指标监控和告警
- Agent资源使用统计
- 跨项目Agent共享机制
- Agent权限和认证管理

---

## 3. 对外行为

### 3.1 输入

#### 来源

- 后端API服务（通过agentApi、templateApi、projectApi）
- 本地Mock数据（开发/测试环境）

#### 参数

| 视图               | 主要输入参数                                                 |
| ------------------ | ------------------------------------------------------------ |
| AgentRegistryView  | useMockData (boolean)                                        |
| AgentTemplatesView | -                                                            |
| AgentChatView      | projectId (string), sessions (SessionRecord[])               |
| AgentIOView        | projectId, project, sessions, tasks, locks, events, timeline |
| AgentLogView       | projectId (string)                                           |
| AgentSessionsView  | projectId (string)                                           |

#### 约束

- 所有API调用均需项目上下文
- Mock数据模式用于离线开发和测试
- SSE流式响应需处理AbortController

### 3.2 输出

#### 结果

- Agent列表、模板列表、会话列表等业务数据展示
- 实时流式响应输出
- 消息发送结果反馈
- 日志内容渲染

#### 触发条件

- 页面加载时自动获取数据
- 用户交互（点击、输入、提交）触发操作
- 定时轮询刷新日志（REFRESH_INTERVAL=3000ms）

---

## 4. 内部逻辑

### 4.1 核心处理规则

#### 数据加载

- 组件挂载时通过useEffect触发数据加载
- 支持Mock数据和真实API两种模式
- 加载状态管理（loading、error）

#### 表单处理

- 受控组件管理表单状态
- 输入验证（必填字段检查）
- 提交时显示loading状态

#### 流式响应

- 使用Fetch API + ReadableStream
- 解析SSE事件（event: 和 data:）
- 实时更新消息列表

#### 日志处理

- JSONL格式日志解析
- 按sessionId分组
- 时间窗口合并（MERGE_WINDOW_MS=30000ms）
- diff块识别和渲染

### 4.2 状态变化

| 视图               | 核心状态                                            |
| ------------------ | --------------------------------------------------- |
| AgentRegistryView  | agents[], editingId, showNew                        |
| AgentTemplatesView | builtInTemplates[], customTemplates[], editingId    |
| AgentChatView      | selectedSession, messages[], loading, currentStep   |
| AgentIOView        | timeline[], expandedItems, kindFilter, showSendForm |
| AgentLogView       | sessionData{}, expandedSessions, isRunning          |
| AgentSessionsView  | sessions[], selectedProjectId                       |

---

## 5. 依赖关系

### 上游依赖

- **后端API服务**: 提供Agent、Template、Session、Project等数据接口
- **路由系统**: 通过React Router管理各视图的访问路径
- **国际化模块**: @/hooks/i18n 提供多语言支持
- **设置模块**: @/hooks/useSettings 提供Mock数据开关
- **类型定义**: @/types 定义所有业务数据类型

### 下游影响

- 为任务管理模块（TaskboardView）提供Agent选择
- 为项目工作区（ProjectWorkspace）提供Agent上下文
- 为调试功能（DebugAgentSessionsView）提供会话数据

---

## 6. 约束条件

### 技术约束

- React 18+ 函数组件
- TypeScript强类型
- SSE流式通信
- JSONL日志格式解析

### 性能要求

- 日志视图需支持大量数据渲染（虚拟滚动优化）
- 实时日志刷新间隔3秒
- 消息列表最大展示200条

### 兼容性

- 浏览器现代特性（Fetch API、ReadableStream）
- Windows/Linux双平台支持

---

## 7. 异常与边界

### 异常处理

- API请求失败显示错误提示
- JSON解析失败跳过异常行
- SSE连接中断显示错误状态
- 删除操作前需要用户确认

### 边界情况

- 空数据展示empty state
- 网络超时处理
- 大日志文件分页/滚动
- 并发编辑冲突提示

---

## 8. 数据定义

### 8.1 关键数据

#### AgentDefinition

`	ypescript
interface AgentDefinition {
  agentId: string;
  displayName: string;
  prompt: string;
  updatedAt: string;
  defaultCliTool?:  codex | trae | minimax;
}
`

#### AgentTemplateDefinition

`	ypescript
interface AgentTemplateDefinition {
  templateId: string;
  displayName: string;
  prompt: string;
}
`

#### SessionRecord

`	ypescript
interface SessionRecord {
  sessionId: string;
  role: string;
  status: running | idle | stopped;
  projectId: string;
  currentTaskId?: string;
  createdAt: string;
  lastActiveAt?: string;
  lastHeartbeat?: string;
  providerSessionId?: string;
}
`

#### AgentIOTimelineItem

`	ypescript
interface AgentIOTimelineItem {
  itemId: string;
  kind: string;
  createdAt: string;
  from?: string;
  toRole?: string;
  toSessionId?: string;
  messageType?: string;
  content?: string;
  requestId?: string;
  messageId?: string;
  status?: string;
  runId?: string;
  discussThreadId?: string;
  taskId?: string;
}
`

### 8.2 生命周期

- Agent注册后持久化存储
- Session随项目存在，会话结束标记为stopped
- 日志数据按项目存储，定时清理
- 模板分为系统内置（不可删改）和用户自定义（可管理）

---

## 9. 待确认问题

### TODO 列表

1. **Agent数量限制**: TODO(需确认: 单个项目可注册的最大Agent数量未定义)

2. **模板同步机制**: TODO(需确认: 模板是否支持跨项目共享或导出导入)

3. **日志保留策略**: TODO(需确认: Agent日志的保留天数和大小限制)

4. **会话超时配置**: TODO(需确认: 判定Session为idle状态的时间阈值)

5. **消息队列限制**: TODO(需确认: AgentIO时间线单页最大条目数)

6. **流式响应中断**: TODO(需确认: 用户中断后的Agent状态处理逻辑)

7. **权限控制**: TODO(需确认: 哪些角色可以创建/编辑/删除Agent)

8. **CLI工具集成**: TODO(需确认: 默认CLI工具的配置优先级和覆盖规则)

---

## 附录：视图文件清单

| 文件路径                         | 功能描述        |
| -------------------------------- | --------------- |
| src/views/AgentRegistryView.tsx  | Agent注册管理   |
| src/views/AgentTemplatesView.tsx | Agent模板管理   |
| src/views/AgentChatView.tsx      | Agent实时对话   |
| src/views/AgentIOView.tsx        | Agent消息IO监控 |
| src/views/AgentLogView.tsx       | Agent日志查看   |
| src/views/AgentSessionsView.tsx  | Agent会话管理   |

---

_文档版本: 1.0_
_创建时间: 2026-02-22_
_编写角色: PRD_Agent_0_
