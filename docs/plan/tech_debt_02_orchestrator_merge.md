# 技术债修复计划 2: 编排器服务合并

> **优先级**: P0 (最高)  
> **风险等级**: 🔴 高  
> **预计工期**: 3周  
> **目标**: 消除 `orchestrator-service.ts` (1081行) 和 `workflow-orchestrator-service.ts` (1072行) 的代码重复

---

## 背景与问题

### 现状

两个编排器服务存在大量重复代码：

| 组件            | orchestrator-service.ts | workflow-orchestrator-service.ts |
| --------------- | ----------------------- | -------------------------------- |
| 会话管理逻辑    | ~150行                  | ~150行 (复制)                    |
| 消息调度逻辑    | ~200行                  | ~180行 (相似)                    |
| MiniMax调用逻辑 | ~100行                  | ~100行 (复制)                    |
| 任务分配逻辑    | ~150行                  | ~120行 (相似)                    |
| 提醒机制        | ~80行                   | ~80行 (复制)                     |

**问题**:

- 重复代码维护成本高（修改需改多处）
- 不一致风险（一处修复可能遗漏另一处）
- 代码膨胀（2153行实际可压缩至 ~1200行）

### 目标架构

```
services/
└── orchestrator/
    ├── base-dispatch-engine.ts      # 公共调度引擎
    ├── session-manager.ts           # 会话生命周期管理
    ├── reminder-service.ts          # 提醒机制
    ├── task-assigner.ts             # 任务分配策略
    ├── dispatch-coordinator.ts      # 调度协调器
    ├── project-orchestrator.ts      # 原 orchestrator-service 重构后
    └── workflow-orchestrator.ts     # 原 workflow-orchestrator-service 重构后
```

---

## 分阶段实施计划

### 阶段1: 重复代码识别与提取规划 (2天)

**目标**: 精确标记重复代码块，制定提取策略

**改动范围**:

```
只读分析文件:
- server/src/services/orchestrator-service.ts
- server/src/services/workflow-orchestrator-service.ts

新增文件:
- docs/plan/orchestrator-refactor-analysis.md (分析文档)
```

**分析方法**:

1. 使用 `diff` 工具对比两个文件
2. 标记相似度 > 80% 的代码块
3. 识别共同依赖（store、logger 等）
4. 识别差异点（workflow 特有的阶段管理）

**预期识别的公共逻辑**:

```typescript
// 1. 会话状态管理 (公共)
-resolveSessionForDispatch() -
  updateSessionStatus() -
  handleSessionTimeout() -
  // 2. 消息调度 (公共)
  dispatchToSession() -
  confirmMessageDelivery() -
  buildDispatchPrompt() -
  // 3. MiniMax 调用 (公共)
  callMiniMaxAgent() -
  handleToolCalls() -
  processAgentResponse() -
  // 4. 提醒机制 (公共)
  calculateNextReminderTime() -
  sendReminderIfNeeded() -
  // 5. 任务选择 (公共)
  selectRunnableTask() -
  checkDependencyGate();
```

**检验标准**:

- [ ] 完整列出所有重复代码段（行号范围）
- [ ] 标记每个重复段的相似度百分比
- [ ] 识别所有差异点和保留逻辑
- [ ] 制定详细的提取顺序计划

---

### 阶段2: 基础组件创建 - SessionManager (3天)

**目标**: 提取会话管理公共逻辑

**改动范围**:

```
新增文件:
- server/src/services/orchestrator/session-manager.ts
- server/src/services/orchestrator/types.ts

修改文件:
- server/src/services/orchestrator-service.ts (使用 SessionManager)
- server/src/services/workflow-orchestrator-service.ts (使用 SessionManager)
```

**SessionManager 接口设计**:

```typescript
// services/orchestrator/session-manager.ts
export interface SessionManager {
  resolveActiveSession(
    projectId: string,
    role: string,
    options?: SessionResolutionOptions
  ): Promise<SessionResolutionResult>;

  updateSessionStatus(projectId: string, sessionId: string, status: SessionStatus): Promise<void>;

  checkSessionTimeout(projectId: string, sessionId: string, timeoutThresholdMs: number): Promise<boolean>;

  dismissSession(projectId: string, sessionId: string, reason: string): Promise<void>;
}

export class FileBasedSessionManager implements SessionManager {
  constructor(
    private sessionStore: SessionStore,
    private logger: Logger
  ) {}

  // 实现...
}
```

**迁移步骤**:

1. 创建 `SessionManager` 接口和实现
2. 在 `orchestrator-service.ts` 中替换原有会话管理代码
3. 在 `workflow-orchestrator-service.ts` 中替换原有会话管理代码
4. 运行测试验证行为一致

**检验标准**:

- [ ] SessionManager 单元测试覆盖率 > 90%
- [ ] orchestrator-service 单元测试通过
- [ ] workflow-orchestrator-service 单元测试通过
- [ ] 会话生命周期 E2E 测试通过

---

### 阶段3: 基础组件创建 - DispatchEngine (3天)

**目标**: 提取消息调度公共逻辑

**改动范围**:

```
新增文件:
- server/src/services/orchestrator/dispatch-engine.ts
- server/src/services/orchestrator/dispatch-coordinator.ts
```

**DispatchEngine 核心设计**:

```typescript
// services/orchestrator/dispatch-engine.ts
export interface DispatchEngine {
  dispatch(context: DispatchContext): Promise<DispatchResult>;

  buildPrompt(context: DispatchContext, messages: Message[], task?: TaskRecord): string;
}

export class MiniMaxDispatchEngine implements DispatchEngine {
  constructor(
    private miniMaxClient: MiniMaxClient,
    private toolRegistry: ToolRegistry,
    private sessionManager: SessionManager
  ) {}

  async dispatch(context: DispatchContext): Promise<DispatchResult> {
    // 1. 构建 prompt
    // 2. 调用 MiniMax
    // 3. 处理工具调用
    // 4. 返回结果
  }
}
```

**关键考量**:

- 保持现有的单 flight 机制（防止重复调度）
- 保持现有的超时处理逻辑
- 支持 workflow 的特殊 dispatch 需求

**检验标准**:

- [ ] DispatchEngine 单元测试覆盖率 > 85%
- [ ] 单 flight 机制测试通过
- [ ] 调度核心测试通过
- [ ] dispatch E2E 测试通过

---

### 阶段4: 基础组件创建 - ReminderService (2天)

**目标**: 提取提醒机制公共逻辑

**改动范围**:

```
新增文件:
- server/src/services/orchestrator/reminder-service.ts
```

**ReminderService 设计**:

```typescript
// services/orchestrator/reminder-service.ts
export interface ReminderService {
  calculateNextReminderTime(reminderCount: number, options?: ReminderOptions): string;

  shouldSendReminder(role: string, idleSince: string, tasks: TaskRecord[]): boolean;

  sendReminder(projectId: string, role: string, context: ReminderContext): Promise<void>;
}
```

**注意**: 此服务已在 `orchestrator-service.ts` 中有良好实现，主要工作是提取为独立模块。

**检验标准**:

- [ ] 提醒时间计算测试通过
- [ ] 指数退避逻辑测试通过
- [ ] 提醒 E2E 测试通过

---

### 阶段5: orchestrator-service 重构 (3天)

**目标**: 使用新的公共组件重构原有服务

**改动范围**:

```
重命名/重构:
- server/src/services/orchestrator-service.ts
  -> server/src/services/orchestrator/project-orchestrator.ts

修改内容:
- 使用 SessionManager 替代内嵌会话逻辑
- 使用 DispatchEngine 替代内嵌调度逻辑
- 使用 ReminderService 替代内嵌提醒逻辑
- 保持原有的 Project 模式特有逻辑
```

**重构步骤**:

1. 创建新文件 `project-orchestrator.ts`
2. 逐个函数迁移，保持行为一致
3. 使用新的公共组件替换重复逻辑
4. 保留 project 特有的 dispatch 策略

**Project 特有逻辑（不提取）**:

- 自动 dispatch 预算管理
- 手动/自动模式切换
- 基于 inbox 消息的 dispatch 触发

**检验标准**:

- [ ] project-orchestrator.ts 行数 < 400 行
- [ ] 所有单元测试通过
- [ ] 性能无退化
- [ ] E2E `pnpm e2e:standard` 通过

---

### 阶段6: workflow-orchestrator-service 重构 (3天)

**目标**: 使用新的公共组件重构 workflow 编排器

**改动范围**:

```
重命名/重构:
- server/src/services/workflow-orchestrator-service.ts
  -> server/src/services/orchestrator/workflow-orchestrator.ts

修改内容:
- 使用 SessionManager
- 使用 DispatchEngine（workflow 模式扩展）
- 使用 ReminderService
- 保留 workflow 特有的阶段管理逻辑
```

**Workflow 特有逻辑（不提取）**:

- 阶段 (phase) 定义和管理
- 阶段依赖检查
- WorkflowRun 生命周期管理
- 阶段间消息路由

**检验标准**:

- [ ] workflow-orchestrator.ts 行数 < 500 行
- [ ] 所有单元测试通过
- [ ] 阶段流转逻辑测试通过
- [ ] E2E `pnpm e2e:workflow` 通过

---

### 阶段7: 兼容性层与验证 (3天)

**目标**: 确保向后兼容，全面验证

**改动范围**:

```
新增文件:
- server/src/services/orchestrator/index.ts (统一导出)

修改文件:
- server/src/app.ts (更新导入路径)
- 所有测试文件 (更新导入路径)

删除文件:
- server/src/services/orchestrator-service.ts (旧文件)
- server/src/services/workflow-orchestrator-service.ts (旧文件)
```

**兼容性层**:

```typescript
// services/orchestrator/index.ts
// 提供向后兼容的导出
export { ProjectOrchestrator as OrchestratorService } from "./project-orchestrator";
export { WorkflowOrchestrator as WorkflowOrchestratorService } from "./workflow-orchestrator";
export { SessionManager, FileBasedSessionManager } from "./session-manager";
export { DispatchEngine, MiniMaxDispatchEngine } from "./dispatch-engine";
export { ReminderService, DefaultReminderService } from "./reminder-service";
```

**验证清单**:

- [ ] `pnpm test` 100% 通过
- [ ] `pnpm e2e:baseline` 通过
- [ ] 代码覆盖率无显著下降
- [ ] 行数统计改善（总代码量减少 > 30%）

---

## 实施风险与应对

| 风险              | 等级  | 描述                   | 应对措施                                                          |
| ----------------- | ----- | ---------------------- | ----------------------------------------------------------------- |
| 行为不一致        | 🔴 高 | 提取公共逻辑后行为改变 | 1. 逐行比对迁移代码<br>2. 保持原有业务逻辑不变<br>3. 完整回归测试 |
| 循环依赖          | 🔴 高 | 公共组件间产生循环依赖 | 1. 严格分层设计<br>2. 使用接口隔离<br>3. 依赖注入管理             |
| 单 flight 失效    | 🔴 高 | 并发调度保护失效       | 1. 保持原有锁机制<br>2. 并发测试覆盖<br>3. 压力测试验证           |
| 性能退化          | 🟡 中 | 额外抽象层引入开销     | 1. 基准测试对比<br>2. 避免过度封装<br>3. 热点代码内联             |
| Workflow 阶段错乱 | 🟡 中 | 阶段流转逻辑出错       | 1. 阶段状态机测试<br>2. 依赖检查测试<br>3. E2E workflow 测试      |

---

## 回滚方案

1. **代码回滚**: 保留旧文件直到验证完成，可随时切换
2. **功能开关**: 通过配置选择使用新/旧实现
3. **灰度验证**: 先在非关键路径验证新组件

---

## 成功指标

| 指标           | 目标值     | 测量方式               |
| -------------- | ---------- | ---------------------- |
| 总代码行数     | 减少 > 30% | `wc -l` 对比           |
| 重复代码率     | < 5%       | CodeClimate 或类似工具 |
| 单元测试覆盖率 | > 85%      | `pnpm test --coverage` |
| 测试通过率     | 100%       | `pnpm test`            |
| E2E 通过率     | 100%       | `pnpm e2e:baseline`    |
| 响应时间       | 无显著退化 | E2E 计时对比           |

---

## 附录: 代码重复详细分析

待阶段1完成后补充完整的重复代码清单。
