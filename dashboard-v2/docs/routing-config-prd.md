# 路由配置模块 PRD

## 1. 模块目标

### 模块职责

路由配置模块负责管理和配置多Agent系统中Agent之间的通信路由关系，包括消息路由、任务分配路由、讨论轮次限制以及各Agent的模型配置。

### 解决问题

- 实现Agent之间的消息传递控制，确保只有授权的Agent之间可以通信
- 控制任务分配权限，只有被授权的Agent可以将任务分配给其他Agent
- 限制Agent之间的讨论轮次，防止无限循环
- 配置各个Agent使用的AI模型(tool、model、effort)

### 业务价值

- 提高系统的安全性和可控性
- 支持灵活的多Agent协作模式配置
- 支持不同场景下使用不同的AI模型
- 通过路由限制优化系统资源使用

## 2. 功能范围

### 包含能力

1. **Agent管理**
   - 添加新Agent到项目
   - 从项目中移除Agent
   - 显示当前所有Agent列表

2. **通信路由配置**
   - 配置Agent之间的消息传递路由
   - 以矩阵形式展示路由关系
   - 支持批量开启/关闭路由

3. **任务分配路由配置**
   - 配置Agent之间的任务分配权限
   - 任务分配路由必须基于通信路由（先开启通信路由才能分配任务）

4. **讨论轮次配置**
   - 为每对Agent配置最大讨论轮次
   - 轮次范围限制：1-500
   - 默认值：20轮

5. **模型配置**
   - 为每个Agent配置AI工具(tool)：codex/trae/minimax
   - 选择具体模型(model)
   - 配置努力程度(effort)：low/medium/high

6. **持久化**
   - 保存配置到后端API
   - 重新加载项目时恢复配置

### 不包含能力

- Agent运行状态监控
- 实时消息传递
- 路由规则的动态调整
- 路由历史记录

## 3. 对外行为

### 3.1 输入

#### 来源

- 用户通过RoutingConfigView界面操作
- 从ProjectDetail中加载初始配置
- 从modelsApi获取可用模型列表

#### 参数

| 参数名    | 类型          | 说明                       |
| --------- | ------------- | -------------------------- |
| projectId | string        | 项目ID                     |
| project   | ProjectDetail | 项目详情（含初始路由配置） |
| reload    | () => void    | 重新加载回调函数           |

#### 约束

- agentIds: 数组元素不能重复
- routeTable[from]: 不能包含from自身
- taskAssignRouteTable[from]: 必须是routeTable[from]的子集
- discussRounds: 数值必须在1-500之间

### 3.2 输出

#### 结果

- 更新项目的路由配置到后端
- 更新任务分配路由配置到后端
- 显示操作成功/失败提示

#### 触发条件

- 用户点击"保存"按钮时触发配置保存
- 保存成功后自动重新加载项目数据

## 4. 内部逻辑

### 核心处理规则

#### 路由矩阵渲染

1. 获取当前agentIds列表
2. 对每个from-agent，遍历to-agents生成路由行
3. 展开/折叠状态控制每行的详细配置显示

#### 路由开关逻辑

- toggleRoute: 切换通信路由，关联更新任务分配路由
- toggleTaskAssign: 切换任务分配路由，受通信路由约束

#### 保存逻辑

1. 调用projectApi.updateRoutingConfig保存:
   - agent_ids
   - route_table
   - route_discuss_rounds
   - agent_model_configs

2. 过滤taskAssignRouteTable，只保留routeTable中已开启的路由

3. 调用projectApi.updateTaskAssignRouting保存过滤后的配置

### 状态变化

- agentIds: 增删操作
- routeTable: 路由开关操作
- taskAssignRouteTable: 分配权限开关操作
- discussRounds: 轮次数值修改
- modelConfigs: 模型选择变更

## 5. 依赖关系

### 上游依赖

- types/index.ts: 类型定义(AgentModelConfig, ProjectDetail等)
- services/api.ts: API调用(projectApi.updateRoutingConfig, projectApi.updateTaskAssignRouting)
- hooks/i18n: 国际化翻译
- lucide-react: 图标组件

### 下游影响

- 任务分发Orchestrator: 根据routeTable和taskAssignRouteTable控制消息分发
- 会话管理: 根据agentModelConfigs选择Agent运行模型
- 任务分配: 根据routeDiscussRounds限制讨论轮次

## 6. 约束条件

### 技术约束

- 前端框架: React + TypeScript
- 状态管理: useState + useEffect + useRef
- UI组件: 自定义组件 + lucide-react图标

### 性能要求

- 路由矩阵渲染: 考虑agent数量增长，建议虚拟列表
- 模型列表获取: 缓存机制避免频繁请求

## 7. 异常与边界

### 异常处理

- 保存失败: 显示错误信息，保留用户输入
- 加载失败: 显示空状态，提示添加agent
- 模型加载失败: 使用空数组，显示静默失败

### 边界情况

- 空agent列表: 显示"Add agents first to configure routing"
- 单个agent: 矩阵只显示列，不显示行（无法与自己通信）
- 路由冲突: taskAssignRouteTable自动过滤不合法配置

## 8. 数据定义

### 关键数据

#### RoutingConfigRequest

```typescript
interface RoutingConfigRequest {
  agent_ids?: string[];
  route_table?: Record<string, string[]>;
  route_discuss_rounds?: Record<string, Record<string, number>>;
  agent_model_configs?: Record<string, AgentModelConfig>;
}
```

#### AgentModelConfig

```typescript
interface AgentModelConfig {
  tool: "codex" | "trae" | "minimax";
  model: string;
  effort?: "low" | "medium" | "high";
}
```

#### DiscussRoundsConfig

```typescript
interface DiscussRoundsConfig {
  [from: string]: {
    [to: string]: number;
  };
}
```

### 生命周期

- 组件挂载: 从project加载初始配置
- 配置变更: 用户操作触发本地状态更新
- 保存操作: 调用API持久化到后端
- 重新加载: 保存成功后调用reload回调刷新数据

## 9. 待确认问题

### TODO(需确认: 原始输入未提供)

- 路由配置是否支持批量导入/导出
- 是否需要路由规则版本管理
- 是否需要路由变更审计日志
- 路由配置的权限控制（哪些用户可以修改）
- 讨论轮次耗尽后的处理策略
- 是否支持路由规则的条件触发（如特定任务类型）
- 模型配置的默认值策略
- 路由配置的测试/验证机制
