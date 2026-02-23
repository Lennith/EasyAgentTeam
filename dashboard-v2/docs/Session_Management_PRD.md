# Session Management PRD

## 1. 模块目标

### 模块职责
提供项目内 Agent Session 的生命周期管理能力，包括会话列表展示、状态监控、强制终止等核心功能。

### 解决问题
1. 用户无法查看项目中各个 Agent Session 的运行状态
2. 用户需要筛选和搜索特定会话
3. 需要终止卡住或异常的会话
4. 需要在调试视图查看跨项目的会话和 I/O 日志

### 业务价值
- 提供可视化的会话管理界面，提升调试效率
- 支持会话状态过滤和关键字搜索，快速定位目标会话
- 提供会话终止能力，管理资源占用

---

## 2. 功能范围

### 包含能力
- 展示项目中所有 Agent Session 的列表
- 按会话状态（running/idle/blocked/dismissed）过滤
- 按 Session ID 或 Role 关键字搜索
- 展示会话详细信息（Session ID、Role、Status、Provider、当前任务、锁数量、创建时间、更新时间、最后活跃时间、最后调度时间）
- 终止（Dismiss）指定会话
- 调试视图：跨项目查看所有会话及 Agent I/O 时间线

### 不包含能力
- 会话的创建/注册（由后端自动创建）
- 会话状态的手动修改（repair 除外）
- 会话消息的发送/调度
- 会话的资源监控（CPU/内存）

---

## 3. 对外行为

### 3.1 输入

#### 来源
- 用户交互（UI 操作）
- 后端 API 响应

#### 参数
- projectId: 项目标识（必填）
- searchQuery: 搜索关键字（可选，默认空字符串），匹配 sessionId、role
- statusFilter: 状态过滤（可选，默认 all），可选值：all, running, idle, blocked, dismissed
- selectedSessionId: 选中的会话 ID（可选）

#### 约束
- projectId 必须为有效的项目标识
- searchQuery 支持模糊匹配，不区分大小写

### 3.2 输出

#### 结果
- filteredSessions: 过滤后的会话列表
- selectedSession: 选中会话的详细信息

#### 触发条件
- 页面加载时自动获取项目会话列表
- 搜索框输入时实时过滤
- 下拉框选择状态时实时过滤
- 点击会话行时展示详情
- 点击终止按钮时触发会话终止

---

## 4. 内部逻辑

### 核心处理规则
1. 列表加载: 组件挂载时调用 projectApi.getSessions(projectId) 获取会话列表
2. 数据过滤: 根据 statusFilter 过滤 status 字段，根据 searchQuery 模糊匹配 sessionId 和 role
3. 终止操作: 调用 projectApi.dismissSession(projectId, sessionId)，成功后调用 reload 刷新列表
4. 详情展示: 从会话列表中查找 selectedSessionId 对应的会话对象

### 状态变化
- 会话状态: running / idle / blocked / dismissed
- UI 状态: loading / loaded / error

---

## 5. 依赖关系

### 上游依赖
- Project Management 模块: 提供 projectId
- API 模块: 提供 getSessions, dismissSession 等接口
- Lock Manager 模块: 会话持有锁的数量信息

### 下游影响
- Task Management: 会话可关联当前任务（currentTaskId）
- Agent I/O Timeline: 会话产生 I/O 日志

---

## 6. 约束条件

### 技术约束
- React Hooks (useState, useMemo, useEffect)
- i18n 国际化支持
- API 错误处理

### 性能要求
- 列表最大高度 400px，超出滚动
- 搜索和过滤使用 useMemo 缓存结果

---

## 7. 异常与边界

### 异常处理
- 加载失败: 显示错误信息，提供重试机制
- 终止失败: 显示错误提示，不自动刷新
- 空列表: 显示空状态提示

### 边界情况
- 无会话数据: 展示空状态
- sessionId 为空: 过滤时跳过
- 已终止会话: 隐藏终止按钮

---

## 8. 数据定义

### 关键数据

#### SessionRecord
| 字段 | 类型 | 说明 |
|------|------|------|
| sessionId | string | 会话唯一标识 |
| projectId | string | 所属项目 |
| role | string | Agent 角色 |
| status | running/idle/blocked/dismissed | 状态 |
| createdAt | string | 创建时间 |
| updatedAt | string | 更新时间 |
| currentTaskId | string? | 当前任务 ID |
| lastHeartbeat | string? | 最后心跳时间 |
| lastActiveAt | string? | 最后活跃时间 |
| lastDispatchedAt | string? | 最后调度时间 |
| agentTool | string? | Agent 工具（codex/trae/minimax） |
| sessionKey | string? | 会话密钥 |
| providerSessionId | string? | 提供商会话 ID |
| provider | string? | 提供商名称 |
| locksHeldCount | number? | 持有锁数量 |

### 生命周期
1. 创建: 后端自动创建，状态为 idle
2. 运行: 接收任务后状态变为 running
3. 阻塞: 等待依赖时状态变为 blocked
4. 终止: 用户手动终止或任务完成，状态变为 dismissed

---

## 9. 待确认问题

TODO(需确认: 原始输入未提供)
1. repairSession 功能的具体触发条件和业务场景
2. registerSession 的调用时机和参数来源
3. 会话超时自动终止的策略
4. 调试视图的权限控制要求