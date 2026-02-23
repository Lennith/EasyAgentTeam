# 任务管理模块 PRD

## 1. 模块目标

### 模块职责
任务管理模块是 dashboard-v2 系统中负责项目任务全生命周期管理的核心模块，提供任务创建、更新、状态流转、可视化查看和任务派发等功能，支持团队协作式任务执行。

### 解决问题
- 任务创建和分配缺乏统一入口
- 任务状态变更缺乏可视化追踪
- 任务依赖关系管理不清晰
- 任务执行进度无法直观展示

### 业务价值
- 为项目经理提供任务规划与跟踪界面
- 为团队成员提供清晰的任务接收和状态更新能力
- 支持任务层级结构（父子任务）管理
- 支持任务生命周期完整追踪

## 2. 功能范围

### 包含能力
1. **任务创建 (CreateTaskView)**
   - 支持设置任务标题
   - 支持选择父级任务（支持 PROJECT_ROOT、USER_ROOT、EXECUTION 类型）
   - 支持指定任务负责人角色
   - 支持配置 write_set（任务可写入的文件/目录路径集合）
   - 支持配置依赖任务列表
   - 支持配置验收标准（acceptance criteria）
   - 支持设置任务来源（from_agent）

2. **任务更新 (UpdateTaskView)**
   - 支持搜索和选择待更新任务
   - 支持更新任务状态（PLANNED/READY/DISPATCHED/IN_PROGRESS/BLOCKED_DEP/MAY_BE_DONE/DONE/CANCELED）
   - 支持重新分配任务负责人
   - 支持修改 write_set
   - 支持修改依赖任务
   - 支持修改验收标准

3. **任务树视图 (TaskTreeView)**
   - 以树形结构展示任务层级关系
   - 支持展开/折叠操作
   - 支持查看任务详情（包含生命周期事件）
   - 支持强制派发任务（Force Dispatch）

4. **任务看板视图 (TaskboardView)**
   - 以 Kanban 看板形式展示任务
   - 按状态分组：Backlog、Ready、In Progress、Blocked、May Be Done、Done
   - 显示统计卡片（总数、进行中、已完成、阻塞、待确认）
   - 支持从看板直接强制派发任务

5. **任务详情模态框 (TaskDetailsModal)**
   - 展示任务创建参数（JSON 格式）
   - 展示任务生命周期事件列表
   - 支持查看 MiniMax 日志
   - 支持查看 Agent IO 时间线

### 不包含能力
- 任务自动调度逻辑（由后端 Orchestrator 处理）
- 任务评论/讨论功能
- 任务时间追踪/工时统计
- 甘特图/时间线视图

## 3. 对外行为

### 3.1 输入

#### 来源
- 用户通过前端 UI 操作触发
- 后端 API 响应返回任务数据

#### 参数

**CreateTaskView 请求参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | 任务标题 |
| parent_task_id | string | 是 | 父任务 ID |
| owner_role | string | 是 | 负责角色 |
| from_agent | string | 否 | 任务来源（默认 manager） |
| write_set | string[] | 否 | 可写入路径列表 |
| dependencies | string[] | 否 | 依赖任务 ID 列表 |
| acceptance | string[] | 否 | 验收标准列表 |

**UpdateTaskView 请求参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| task_id | string | 是 | 任务 ID |
| state | TaskState | 否 | 任务状态 |
| owner_role | string | 否 | 负责角色 |
| write_set | string[] | 否 | 可写入路径列表 |
| dependencies | string[] | 否 | 依赖任务列表 |
| acceptance | string[] | 否 | 验收标准列表 |

#### 约束
- task_id 格式：task-{timestamp}-{random}
- 任务状态流转必须符合状态机规则
- 依赖任务不能形成循环引用
- write_set 路径必须为有效的项目相对路径

### 3.2 输出

#### 结果
- 任务创建：返回包含 task_id 的创建结果
- 任务更新：返回更新成功状态
- 任务列表：返回 TaskTreeNode[] 数组
- 任务详情：返回 TaskDetail 对象

#### 触发条件
- 用户进入任务管理相关视图时加载任务列表
- 用户提交任务创建/更新表单时触发 API 调用
- 用户点击任务项时加载任务详情

## 4. 内部逻辑

### 核心处理规则

1. **任务创建流程**
   用户填写表单 -> 验证必填字段 -> 生成 task_id -> 调用 projectApi.taskAction -> 处理响应 -> 显示结果

2. **任务更新流程**
   用户选择任务 -> 加载任务详情到表单 -> 用户修改字段 -> 调用 projectApi.patchTask -> 刷新列表

3. **任务派发流程**
   用户点击派发按钮 -> 查找对应角色的可用 session -> 调用 projectApi.dispatch -> 处理结果

4. **任务树构建逻辑**
   - 过滤 PROJECT_ROOT 和 USER_ROOT 类型节点作为根节点隐藏
   - 根据 parent_task_id 建立父子关系
   - 支持多级嵌套

5. **看板分组逻辑**
   - PLANNED -> Backlog
   - READY -> Ready
   - DISPATCHED/IN_PROGRESS -> In Progress
   - BLOCKED_DEP -> Blocked
   - MAY_BE_DONE -> May Be Done
   - DONE/CANCELED -> Done

### 状态变化

**TaskState 状态机：**
- PLANNED -> READY -> DISPATCHED -> IN_PROGRESS -> MAY_BE_DONE -> DONE
- 任何非终态 -> CANCELED
- 任何非终态 -> BLOCKED_DEP（依赖未满足）

## 5. 依赖关系

### 上游依赖
- **ProjectService** (src/services/api.ts): 提供 projectApi.taskAction、projectApi.patchTask、projectApi.dispatch 等方法
- **i18n Hook** (src/hooks/i18n): 提供多语言翻译功能

### 下游影响
- TaskTreeView: 为其他模块提供任务树展示能力
- TaskboardView: 为其他模块提供任务看板展示能力
- SessionManagerView: 任务派发依赖会话管理

### 数据依赖
- TaskTreeNode: 任务树节点数据结构
- TaskDetail: 任务详情数据结构
- TaskLifecycleEvent: 生命周期事件结构

## 6. 约束条件

### 技术约束
- 前端框架：React + TypeScript
- UI 组件库：自定义样式组件
- 状态管理：React Hooks (useState, useMemo, useEffect)
- 国际化：i18n hook

### 性能要求
- 任务列表加载应支持分页或虚拟滚动（当前限制显示前 50 条）
- 任务树展开/折叠应保持响应性

### 数据约束
- task_id 全局唯一
- parent_task_id 必须指向已存在的任务
- owner_role 必须是项目中已注册的角色

## 7. 异常与边界

### 异常处理
1. **任务创建失败** - 显示错误消息，保留表单数据
2. **任务更新失败** - 显示错误消息，保留表单数据
3. **任务派发失败** - 显示派发结果和原因
4. **任务详情加载失败** - 显示空状态提示

### 边界情况
1. **空任务列表** - 显示 No data / No tasks
2. **无父任务时** - 默认选择 PROJECT_ROOT 类型根任务
3. **任务状态为 DONE/CANCELED** - 禁用派发按钮
4. **依赖任务已取消** - 允许选择但可能影响执行

## 8. 数据定义

### 关键数据结构

**TaskTreeNode:**
- task_id: string - 任务唯一标识
- task_kind: PROJECT_ROOT | USER_ROOT | EXECUTION - 任务类型
- parent_task_id: string | null - 父任务 ID
- root_task_id: string | null - 根任务 ID
- title: string - 任务标题
- state: TaskState - 任务状态
- creator_role: string | null - 创建者角色
- creator_session_id: string | null - 创建者会话 ID
- owner_role: string - 负责角色
- owner_session: string | null - 负责会话 ID
- priority: number - 优先级
- dependencies: string[] - 依赖任务 ID 列表
- write_set: string[] - 可写入路径列表
- acceptance: string[] - 验收标准列表
- artifacts: string[] - 产出物列表
- alert: string | null - 告警信息
- granted_at: string | null - 授权时间
- closed_at: string | null - 关闭时间
- last_summary: string | null - 最后摘要
- created_at: string - 创建时间
- updated_at: string - 更新时间

**TaskDetail:**
- project_id: string - 项目 ID
- task_id: string - 任务 ID
- task: TaskTreeNode - 任务节点
- created_by: { role: string; session_id?: string } - 创建者信息
- create_parameters?: Record<string, unknown> - 创建参数
- lifecycle: TaskLifecycleEvent[] - 生命周期事件列表
- stats: { lifecycle_event_count: number } - 统计信息

**TaskState:**
- PLANNED - 计划中
- READY - 已就绪
- DISPATCHED - 已派发
- IN_PROGRESS - 进行中
- BLOCKED_DEP - 阻塞（依赖）
- MAY_BE_DONE - 可能已完成
- DONE - 已完成
- CANCELED - 已取消

### 生命周期

1. 创建阶段：用户填写表单 -> 生成 task_id -> 存储到后端
2. 执行阶段：DISPATCHED -> IN_PROGRESS -> MAY_BE_DONE -> DONE
3. 终止阶段：任何状态 -> CANCELED
4. 阻塞阶段：任何非终态 -> BLOCKED_DEP（依赖未满足）

## 9. 待确认问题

1. TODO(需确认: 原始输入未提供): 任务优先级（priority）字段的具体业务含义和使用场景
2. TODO(需确认: 原始输入未提供): write_set 的路径验证规则（是否需要存在性检查）
3. TODO(需确认: 原始输入未提供): 任务自动派发（auto-dispatch）的触发条件和配置方式
4. TODO(需确认: 原始输入未提供): MAY_BE_DONE 状态的确认机制（手动确认还是自动检测）
5. TODO(需确认: 原始输入未提供): 跨项目任务依赖的处理方式
