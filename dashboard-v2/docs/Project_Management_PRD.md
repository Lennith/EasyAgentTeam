# 项目管理模块 PRD

## 1. 模块目标
模块职责：
提供项目管理能力，支持项目的创建、查看、删除，以及项目工作区的多视图展示和项目配置管理。

解决问题：
- 用户需要创建和管理多个独立的项目工作区
- 用户需要在项目内查看任务进度、事件日志、会话状态
- 用户需要配置项目的调度器设置和路由规则

业务价值：
- 实现项目的隔离管理，每个项目有独立的配置和资源
- 提供统一的操作入口，支持任务的创建、分配、跟踪
- 支持团队协作，配置路由规则实现多Agent协调

## 2. 功能范围
包含能力：
- 项目列表展示（ProjectsHome）
- 项目创建（NewProjectView）：支持选择模板、团队、Agent
- 项目删除
- 项目工作区（ProjectWorkspace）：多视图容器
  - 事件时间线（EventTimelineView）
  - 聊天时间线（ChatTimelineView）
  - 会话管理（SessionManagerView）
  - Agent IO（AgentIOView）
  - Agent 聊天（AgentChatView）
  - 任务看板（TaskboardView）
  - 任务树（TaskTreeView）
  - 创建任务（CreateTaskView）
  - 更新任务（UpdateTaskView）
  - 锁管理（LockManagerView）
  - 团队配置（RoutingConfigView）
  - 项目设置（ProjectSettingsView）
- 项目设置管理（ProjectSettingsView）：
  - 调度器自动分发配置
  - 剩余分发次数配置
  - 项目信息展示

不包含能力：
- 项目模板定义（模板管理由独立的模板模块负责）
- 项目文件系统的直接操作
- 跨项目任务依赖

## 3. 对外行为

### 3.1 输入
来源：
- 用户交互（页面操作）
- 后端API调用

参数：
- projectId：项目唯一标识
- name：项目名称
- workspacePath：工作区路径
- templateId：模板ID（可选）
- teamId：团队ID（可选）
- agentIds：Agent ID列表（可选）

约束：
- projectId：必填，小写字母、数字、下划线组合
- name：必填，非空字符串
- workspacePath：必填，有效路径格式
- templateId、teamId、agentIds：可选

### 3.2 输出
结果：
- 项目列表：ProjectSummary[]
- 项目详情：ProjectDetail
- 项目工作区数据：sessions, tasks, locks, events, timeline
- 任务树：TaskTreeResponse
- 任务详情：TaskDetail

触发条件：
- 页面加载时获取数据
- 用户提交表单时创建/更新项目
- 用户点击操作按钮时触发相应API

## 4. 内部逻辑
核心处理规则：
- ProjectWorkspace根据URL参数(projectId, view)动态渲染子视图
- 使用React Hooks管理状态：useProjectWorkspace获取工作区数据
- 表单验证：必填字段校验
- 加载状态管理：loading/success/error三种状态

状态变化：
- 初始 -> 加载中 -> 成功/错误
- 创建项目 -> 保存中 -> 成功/失败 -> 跳转或提示

## 5. 依赖关系
上游依赖：
- 项目模板服务（projectTemplateApi）
- Agent服务（agentApi）
- 团队服务（teamApi）

下游影响：
- 任务模块：项目管理任务的创建和更新
- 会话模块：项目内会话的管理
- 路由模块：项目级路由配置

## 6. 约束条件
技术约束：
- 前端框架：React + TypeScript
- 路由：Hash Router（基于URL hash）
- 状态管理：React Hooks
- API通信：RESTful + JSON

性能要求：
- 列表加载：应小于2秒
- 表单提交：应小于3秒
- 实时数据：定时刷新或WebSocket（TODO）

## 7. 异常与边界
异常处理：
- 网络错误：显示错误消息，提供重试按钮
- API返回错误：解析错误消息并展示
- 数据为空：显示空状态UI

边界情况：
- 无项目：显示空状态和创建按钮
- 项目不存在：显示404错误
- 表单验证失败：实时提示错误信息
- 并发删除：乐观更新，失败回滚

## 8. 数据定义
关键数据：
- ProjectSummary：{projectId, name, workspacePath}
- ProjectDetail：继承ProjectSummary，额外包含createdAt, updatedAt, templateId, agentIds, routeTable等
- OrchestratorSettings：{project_id, auto_dispatch_enabled, auto_dispatch_remaining, updated_at}
- SessionRecord：{sessionId, projectId, role, status, ...}
- TaskTreeNode：{task_id, task_kind, parent_task_id, root_task_id, title, state, ...}

生命周期：
- 创建：用户填写表单 -> API调用 -> 后端存储 -> 前端更新
- 读取：页面加载 -> API调用 -> 数据展示
- 更新：用户修改 -> 表单提交 -> API调用 -> 前端更新
- 删除：用户确认 -> API调用 -> 前端移除

## 9. 待确认问题
TODO(需确认: 原始输入未提供)
- 项目的最大数量限制
- 工作区路径的验证规则
- 自动调度器的触发条件
- 任务依赖的深度限制
- 路由配置的默认值
