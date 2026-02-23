# 设置模块 PRD

## 1. 模块目标

### 模块职责
设置模块负责管理系统级和项目级的配置参数，包括Dashboard界面设置、模型运行时配置、MiniMax Agent配置以及项目编排器设置。

### 解决问题
- 用户无法自定义界面主题和数据源
- 无法配置各模型运行时的命令行工具路径
- 无法配置MiniMax Agent的API参数和会话参数
- 无法配置项目的自动调度功能和剩余配额

### 业务价值
- 提供灵活的界面定制能力（主题切换）
- 支持Mock数据模式便于前端开发调试
- 提供统一的模型运行时配置入口
- 支持项目级别的编排调度配置

## 2. 功能范围

### 包含能力

#### Dashboard设置 (SettingsView)
- 数据源切换：Live API / Mock Data
- 主题切换：Dark / Vibrant Medium / Lively Day
- Codex CLI命令配置
- Trae CLI命令配置
- MiniMax API Key配置
- MiniMax API Base URL配置
- MiniMax模型选择
- MiniMax会话目录配置
- MiniMax最大步数配置
- MiniMax Token限制配置

#### 项目设置 (ProjectSettingsView)
- 自动调度开关：启用/禁用
- 自动调度剩余次数配置
- 项目信息展示：名称、项目ID、工作空间路径、创建时间、Agent列表
- 编排器设置刷新

### 不包含能力
- 用户认证和权限管理
- 团队级别设置
- 项目模板管理
- 系统日志查看

## 3. 对外行为

### 3.1 输入

#### 来源
- 用户界面交互
- 后端API响应

#### Dashboard设置参数
| 参数名称 | 类型 | 必填 | 说明 |
|---------|------|------|------|
| codexCliCommand | string | 否 | Codex CLI命令 |
| traeCliCommand | string | 否 | Trae CLI命令 |
| theme | Theme | 否 | 主题 (dark/vibrant/lively) |
| minimaxApiKey | string | 否 | MiniMax API密钥 |
| minimaxApiBase | string | 否 | MiniMax API基础URL |
| minimaxModel | string | 否 | MiniMax模型名称 |
| minimaxSessionDir | string | 否 | MiniMax会话目录 |
| minimaxMaxSteps | number | 否 | 最大步数 (1-1000) |
| minimaxTokenLimit | number | 否 | Token限制 (1000-200000) |

#### 项目设置参数
| 参数名称 | 类型 | 必填 | 说明 |
|---------|------|------|------|
| auto_dispatch_enabled | boolean | 是 | 是否启用自动调度 |
| auto_dispatch_remaining | number | 是 | 剩余自动调度次数 |

#### 约束
- theme: 必须是预定义的主题值之一
- minimaxMaxSteps: 范围1-1000
- minimaxTokenLimit: 范围1000-200000
- auto_dispatch_remaining: 必须 >= 0

### 3.2 输出

#### Dashboard设置结果
- RuntimeSettings: 完整的运行时设置对象
- 操作状态: 成功/失败消息

#### 项目设置结果
- OrchestratorSettings: 项目编排器设置
- 操作状态: 成功/失败消息

#### 触发条件
- 页面加载时自动获取设置
- 保存按钮点击时提交设置
- 刷新按钮点击时重新加载设置

## 4. 内部逻辑

### 核心处理规则

#### 设置加载
1. 调用settingsApi.get()获取Dashboard设置
2. 填充各表单字段
3. 使用useSettings hook管理本地状态

#### 设置保存
1. 收集所有表单数据
2. 调用settingsApi.update()保存
3. 应用主题到document.documentElement
4. 显示成功/失败提示

#### 数据源切换
- Live API模式：使用真实后端API
- Mock Data模式：使用本地模拟数据
- 切换后立即生效，无需保存

#### 项目设置保存
1. 收集自动调度配置
2. 调用projectApi.updateOrchestratorSettings()
3. 显示成功/失败提示

### 状态变化
- 页面状态: loading / idle / saving
- 表单状态: clean / dirty
- 数据源: useMockData (boolean)

## 5. 依赖关系

### 上游依赖
- 后端API服务: 提供设置读写接口
- 国际化模块: 提供翻译文本

### 下游影响
- 主题系统: 使用设置中的theme配置
- 数据层: 根据useMockData决定数据来源
- 编排器: 使用项目设置中的自动调度配置

## 6. 约束条件

### 技术约束
- 前端基于React + TypeScript
- 使用settingsApi和projectApi服务
- 本地设置使用localStorage持久化

### 性能要求
- 设置加载响应时间 < 1秒
- 设置保存响应时间 < 1秒
- 主题切换即时生效

## 7. 异常与边界

### 异常处理
- 网络错误: 显示错误消息，提供重试机制
- 校验失败: 显示具体字段错误
- API失败: 显示失败原因

### 边界情况
- 未配置时: 使用默认值填充表单
- API返回空: 使用空字符串作为默认值
- localStorage不可用: 使用内存状态

## 8. 数据定义

### 关键数据

#### RuntimeSettings
`	ypescript
{
  codexCliCommand?: string;
  traeCliCommand?: string;
  theme?: Theme;
  minimaxApiKey?: string;
  minimaxApiBase?: string;
  minimaxModel?: string;
  minimaxSessionDir?: string;
  minimaxMcpServers?: MCPServerConfig[];
  minimaxMaxSteps?: number;
  minimaxTokenLimit?: number;
  updatedAt?: string;
}
`

#### DashboardSettings (本地存储)
`	ypescript
{
  useMockData: boolean;
}
`

#### OrchestratorSettings
`	ypescript
{
  project_id: string;
  auto_dispatch_enabled: boolean;
  auto_dispatch_remaining: number;
  updated_at: string;
}
`

#### Theme
`	ypescript
type Theme = "dark" | "vibrant" | "lively";
`

### 生命周期
- Dashboard设置: settingsApi.get -> 本地状态 -> settingsApi.update -> 后端持久化
- 项目设置: projectApi.getOrchestratorSettings -> 本地状态 -> projectApi.updateOrchestratorSettings -> 后端持久化
- 本地设置: localStorage持久化

## 9. 待确认问题

### TODO(需确认: 原始输入未提供)
- MiniMax MCP服务器配置如何使用？
- 是否需要导入/导出设置功能？
- 是否需要设置版本管理和回滚？
- 自动调度次数的消耗逻辑是什么？
