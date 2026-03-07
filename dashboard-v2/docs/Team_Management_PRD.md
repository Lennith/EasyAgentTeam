# 团队管理模块 PRD

## 1. 模块目标

### 模块职责

团队管理模块负责创建和管理团队，实现多Agent之间的信息路由分发、任务分配路由、讨论轮次控制，以及成员(Agent)模型配置等功能。

### 解决问题

- 团队成员配置分散管理困难：通过团队模块集中配置解决
- 缺乏多Agent协调机制：支持信息路由和任务分配路由配置
- 成员模型配置不灵活：为每位成员配置模型响应参数和投入程度

### 业务价值

- 提供团队级别的统一管理视图
- 支持多路由规则协调运作
- 支持多模型供应商(Codex/Trae/MiniMax)的成员配置

---

## 2. 功能范围

### 包含能力

#### 2.1 团队列表展示 (TeamsHomeView)

- 显示所有已创建团队的基本信息
- 支持创建新团队(可选择项目、配置路由和模型)

#### 2.2 团队创建 (NewTeamView)

- 填写团队名称、描述
- 添加团队成员(Agent)
- 配置信息路由表
- 配置任务分配路由表
- 配置讨论轮次
- 配置成员模型

#### 2.3 团队编辑 (EditTeamView)

- 修改团队名称、描述
- 添加/移除团队成员
- 修改信息路由表
- 修改任务分配路由表
- 修改讨论轮次配置
- 修改成员模型配置

#### 2.4 团队删除 (DeleteTeamView)

- 支持删除指定团队

#### 2.5 成员(Agent)管理

- 添加成员：选择Agent并添加到团队
- 移除成员：同时清理该成员相关的路由配置

#### 2.6 信息路由配置 (RouteTableConfig)

- 设置源成员到目标成员的信息分发规则
- 支持一对多、多对一、多对多的路由关系

#### 2.7 任务分配路由配置 (TaskAssignRouteTable)

- 设置源成员到目标成员的任务分发规则

#### 2.8 模型配置 (AgentModelConfig)

- 为每个成员配置模型供应商
- 配置响应模型名称
- 配置投入程度(low/medium/high)

### 不包含能力

- 团队成员实时状态监控
- 团队操作日志查看
- 团队任务指标统计

---

## 3. 对外行为

### 3.1 输入

#### 来源

- 用户交互(页面操作)
- 后端API调用(teamApi)

#### 参数

| 参数名称                | 类型                                   | 必填 | 说明           |
| ----------------------- | -------------------------------------- | ---- | -------------- |
| team_id                 | string                                 | 是   | 团队唯一标识   |
| name                    | string                                 | 是   | 团队名称       |
| description             | string                                 | 否   | 团队描述       |
| agent_ids               | string[]                               | 否   | 团队成员ID列表 |
| route_table             | Record<string, string[]>               | 否   | 信息路由表     |
| task_assign_route_table | Record<string, string[]>               | 否   | 任务分配路由表 |
| route_discuss_rounds    | Record<string, Record<string, number>> | 否   | 讨论轮次配置   |
| agent_model_configs     | Record<string, AgentModelConfig>       | 否   | 成员模型配置   |

#### 约束

- team_id: 小写字母、数字、下划线组合
- agent_ids: 成员ID列表不允许重复
- route_table: 源成员和目标成员必须在agent_ids中
- route_discuss_rounds: 讨论轮次范围1-500

### 3.2 输出

#### 结果

- 团队列表：TeamSummary[] (teamId, name, description, agentCount, createdAt, updatedAt)
- 团队详情：TeamRecord (包含所有配置信息)
- 操作结果：成功/失败状态，错误信息

#### 触发条件

- 页面加载时自动获取团队列表
- 创建/编辑/删除操作后刷新列表
- 切换标签页时加载对应数据

---

## 4. 内部逻辑

### 4.1 核心处理规则

#### 团队创建

1. 验证team_id和name为必填字段
2. 可选配置项目路由表和模型配置
3. 调用teamApi.create创建团队
4. 创建成功后跳转到团队编辑页面

#### 团队编辑

1. 加载团队现有配置
2. 用户修改各配置项
3. 调用teamApi.update进行修改
4. 修改成功后显示成功提示并刷新列表

#### 团队删除

1. 弹出确认对话框
2. 调用teamApi.delete删除团队
3. 从列表中移除已删除的团队

#### 成员管理

- 添加成员：验证成员ID存在且不重复
- 移除成员：同时清理该成员相关的所有路由配置

#### 路由配置

- 信息路由：指定源成员可以向哪些目标成员分发信息
- 任务路由：指定源成员可以向哪些目标成员分配任务
- 讨论轮次：针对信息路由，为每次讨论设置最大轮次

#### 模型配置

- 支持供应商：codex, trae, minimax
- 每个供应商对应不同的模型列表
- 投入程度：low, medium, high

### 4.2 状态变化

- 页面状态：loading / idle / saving / error
- 表单状态：clean / dirty (是否存在未保存修改)
- 团队状态：active / deleted

---

## 5. 依赖关系

### 上游依赖

- 项目模块：提供项目上下文选择
- 模板模块：提供模板列表
- Agent管理模块：提供可添加的Agent列表

### 下游影响

- 任务模块：使用团队的路由配置进行任务分发
- 会话模块：使用团队配置进行会话初始化

---

## 6. 约束条件

### 技术约束

- 前端框架：React + TypeScript
- 使用teamApi与后端通信
- 路由配置采用邻接表结构存储

### 性能要求

- 团队列表加载时间 < 2秒
- 团队配置保存响应时间 < 1秒

---

## 7. 异常与边界

### 异常处理

- 网络错误：显示错误提示，提供重试按钮
- 验证失败：显示具体字段的错误信息
- 删除失败：显示失败原因，保留团队

### 边界情况

- 无团队列表：显示空状态视图和创建按钮
- 无成员时：显示路由配置tab，提示添加成员
- 路由配置循环：防止循环路由，提示错误
- 模型列表为空：显示提示信息

---

## 8. 数据定义

### 8.1 关键数据

#### TeamRecord

```typescript
{
  schemaVersion: "1.0";
  teamId: string;
  name: string;
  description?: string;
  agentIds: string[];
  routeTable: Record<string, string[]>;
  taskAssignRouteTable: Record<string, string[]>;
  routeDiscussRounds: Record<string, Record<string, number>>;
  agentModelConfigs: Record<string, AgentModelConfig>;
  createdAt: string;
  updatedAt: string;
}
```

#### AgentModelConfig

```typescript
{
  tool: "codex" | "trae" | "minimax";
  model: string;
  effort: "low" | "medium" | "high";
}
```

#### TeamSummary

```typescript
{
  teamId: string;
  name: string;
  description?: string;
  agentCount: number;
  createdAt: string;
  updatedAt: string;
}
```

### 8.2 生命周期

- 创建：teamApi.create -> 持久化团队配置
- 读取：teamApi.get / teamApi.list -> 从后端获取
- 更新：teamApi.update -> 增量更新配置
- 删除：teamApi.delete -> 软删除或硬删除

---

## 9. 待确认问题

### TODO 列表

1. **团队删除策略**: TODO(需确认: 团队删除是否为软删除，可否恢复)

2. **权限配置**: TODO(需确认: 是否支持权限配置)

3. **团队模板功能**: TODO(需确认: 是否需要团队模板功能)

4. **讨论轮次默认值**: TODO(需确认: 讨论轮次的默认值是多少)

5. **模型列表来源**: TODO(需确认: 各供应商的模型列表是否从后端获取)

6. **路由验证规则**: TODO(需确认: 路由配置是否需要额外的业务规则验证)

---

## 附录：视图文件清单

| 文件路径                            | 功能描述         |
| ----------------------------------- | ---------------- |
| src/views/TeamsHomeView.tsx         | 团队列表展示     |
| src/views/NewTeamView.tsx           | 团队创建         |
| src/views/EditTeamView.tsx          | 团队编辑         |
| src/views/TeamDetailView.tsx        | 团队详情         |
| src/views/RouteTableConfig.tsx      | 信息路由配置     |
| src/views/TaskAssignRouteConfig.tsx | 任务分配路由配置 |
| src/views/AgentModelConfig.tsx      | 成员模型配置     |

---

_文档版本: 1.0_
_创建时间: 2026-02-22_
_编写角色: PRD Writer_
