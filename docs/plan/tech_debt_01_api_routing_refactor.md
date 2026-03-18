# 技术债修复计划 1: API路由层重构

> **优先级**: P0 (最高)  
> **风险等级**: 🔴 高  
> **预计工期**: 2周  
> **目标**: 拆分 `server/src/app.ts` (3291行) 为模块化控制器架构

---

## 背景与问题

### 现状

`server/src/app.ts` 当前 3291 行，集中定义了所有 Express 路由：

- 违反单一职责原则
- 代码冲突概率高
- 维护困难，新功能添加成本高
- 无法独立测试各模块

### 目标架构

```
src/
├── controllers/          # 按资源组织的控制器
│   ├── project-controller.ts
│   ├── session-controller.ts
│   ├── message-controller.ts
│   ├── task-controller.ts
│   ├── orchestrator-controller.ts
│   ├── workflow-controller.ts
│   └── agent-controller.ts
├── routes/               # 路由注册
│   ├── project-routes.ts
│   ├── session-routes.ts
│   └── ...
└── app.ts               # < 200行，仅中间件和路由mount
```

---

## 分阶段实施计划

### 阶段1: 基础设施搭建 (2天)

**目标**: 创建目录结构和基础接口

**改动范围**:

```
新增目录:
- server/src/controllers/
- server/src/routes/

新增文件:
- server/src/controllers/base-controller.ts
- server/src/controllers/types.ts
```

**代码示例**:

```typescript
// controllers/base-controller.ts
export interface Controller {
  readonly path: string;
  registerRoutes(app: Express.Application): void;
}

export abstract class BaseController implements Controller {
  abstract readonly path: string;

  protected sendJson<T>(res: Response, data: T, status = 200): void {
    res.status(status).json(data);
  }

  protected sendError(res: Response, error: ApiErrorResponse, status = 400): void {
    res.status(status).json({ error });
  }
}
```

**检验标准**:

- [ ] 目录结构创建完成
- [ ] TypeScript 编译通过
- [ ] 现有测试全部通过（此阶段不改动业务代码）

---

### 阶段2: Project API 迁移 (3天)

**目标**: 迁移所有 `/api/projects` 相关路由

**改动范围**:

```
新增文件:
- server/src/controllers/project-controller.ts
- server/src/routes/project-routes.ts

迁移的API (从 app.ts):
├── GET    /api/projects
├── POST   /api/projects
├── GET    /api/projects/:projectId
├── PATCH  /api/projects/:projectId
├── DELETE /api/projects/:projectId
├── GET    /api/projects/:projectId/task-tree
├── GET    /api/projects/:projectId/agent-io/timeline
├── GET    /api/projects/:projectId/events
├── GET    /api/projects/:projectId/taskboard
├── GET    /api/projects/:projectId/routing-config
└── PATCH  /api/projects/:projectId/routing-config
```

**代码示例**:

```typescript
// controllers/project-controller.ts
export class ProjectController extends BaseController {
  readonly path = "/api/projects";

  constructor(private projectService: ProjectService) {
    super();
  }

  registerRoutes(app: Express.Application): void {
    app.get(this.path, this.listProjects.bind(this));
    app.post(this.path, this.createProject.bind(this));
    app.get(`${this.path}/:projectId`, this.getProject.bind(this));
    app.patch(`${this.path}/:projectId`, this.updateProject.bind(this));
    app.delete(`${this.path}/:projectId`, this.deleteProject.bind(this));
    // ... 子路由
  }

  private async listProjects(req: Request, res: Response): Promise<void> {
    const projects = await this.projectService.listProjects();
    this.sendJson(res, projects);
  }
  // ...
}
```

**app.ts 修改**:

```typescript
// app.ts 中原有代码替换为:
import { ProjectController } from "./controllers/project-controller";

const projectController = new ProjectController(projectService);
projectController.registerRoutes(app);
// 删除原有的 /api/projects 路由定义
```

**检验标准**:

- [ ] 所有 Project API 正常工作
- [ ] `app.ts` 行数减少 > 500 行
- [ ] 单元测试通过率 100%
- [ ] E2E 测试 `pnpm e2e:standard` 通过

---

### 阶段3: Session 与 Message API 迁移 (3天)

**目标**: 迁移会话和消息相关路由

**改动范围**:

```
新增文件:
- server/src/controllers/session-controller.ts
- server/src/controllers/message-controller.ts
- server/src/routes/session-routes.ts
- server/src/routes/message-routes.ts

迁移的API:
Session:
├── POST   /api/projects/:id/sessions
├── GET    /api/projects/:id/sessions
├── PATCH  /api/projects/:id/sessions/:sessionId
├── POST   /api/projects/:id/sessions/:sessionId/dismiss
└── POST   /api/projects/:id/sessions/:sessionId/repair

Message:
├── POST   /api/projects/:id/messages/send
├── GET    /api/projects/:id/messages
├── POST   /api/projects/:id/messages/:messageId/confirm
└── GET    /api/projects/:id/messages/pending

Locks:
├── POST   /api/projects/:id/locks/acquire
├── POST   /api/projects/:id/locks/:lockId/release
└── GET    /api/projects/:id/locks
```

**检验标准**:

- [ ] Session/Message/Locks API 全部正常工作
- [ ] `app.ts` 行数减少 > 800 行
- [ ] 会话生命周期测试通过
- [ ] 锁机制测试通过

---

### 阶段4: Task 与 Orchestrator API 迁移 (4天)

**目标**: 迁移任务管理和编排器路由

**改动范围**:

```
新增文件:
- server/src/controllers/task-controller.ts
- server/src/controllers/orchestrator-controller.ts

迁移的API:
Task:
├── POST   /api/projects/:id/task-actions
├── GET    /api/projects/:id/task-tree
├── GET    /api/projects/:id/tasks/:taskId
└── GET    /api/projects/:id/taskboard

Orchestrator:
├── POST   /api/projects/:id/dispatch
├── POST   /api/projects/:id/force-dispatch
├── POST   /api/projects/:id/dispatch-message
├── GET    /api/orchestrator/status
└── POST   /api/orchestrator/settings
```

**风险点**:

- Task Action API 是核心业务逻辑，需特别注意保持行为一致
- 编排器调度逻辑复杂，需完整测试覆盖

**检验标准**:

- [ ] Task CRUD 和状态流转正常
- [ ] 编排器调度正常
- [ ] `app.ts` 行数减少 > 1200 行
- [ ] 编排器核心测试通过
- [ ] E2E `pnpm e2e:workflow` 通过

---

### 阶段5: Workflow 与 Agent API 迁移 (3天)

**目标**: 迁移工作流和智能体相关路由

**改动范围**:

```
新增文件:
- server/src/controllers/workflow-controller.ts
- server/src/controllers/agent-controller.ts

迁移的API:
Workflow:
├── GET    /api/workflows
├── POST   /api/workflows
├── GET    /api/workflows/:workflowId
├── POST   /api/workflows/:workflowId/runs
├── GET    /api/workflows/:workflowId/runs/:runId
└── GET    /api/workflows/:workflowId/runs/:runId/status

Agent:
├── GET    /api/agents
├── POST   /api/agents
├── GET    /api/agents/:agentId
├── PATCH  /api/agents/:agentId
├── DELETE /api/agents/:agentId
├── GET    /api/agent-templates
└── GET    /api/skills
```

**检验标准**:

- [ ] Workflow 创建和运行正常
- [ ] Agent CRUD 正常
- [ ] `app.ts` 行数减少 > 1500 行
- [ ] E2E 全部通过

---

### 阶段6: 验证与清理 (2天)

**目标**: 最终验证和代码清理

**改动范围**:

```
修改:
- server/src/app.ts -> 目标: < 200行

删除:
- app.ts 中所有内联路由处理代码
- 未使用的导入语句
```

**最终 app.ts 结构**:

```typescript
import express from "express";
import { ProjectController } from "./controllers/project-controller";
import { SessionController } from "./controllers/session-controller";
// ... 其他导入

export function createApp(options: AppOptions = {}): express.Application {
  const app = express();

  // 中间件
  app.use(express.json({ limit: "50mb" }));
  app.use(cors());

  // 控制器注册
  new ProjectController(projectService).registerRoutes(app);
  new SessionController(sessionService).registerRoutes(app);
  new MessageController(messageService).registerRoutes(app);
  new TaskController(taskService).registerRoutes(app);
  new OrchestratorController(orchestratorService).registerRoutes(app);
  new WorkflowController(workflowService).registerRoutes(app);
  new AgentController(agentService).registerRoutes(app);

  // 错误处理中间件
  app.use(errorHandler);

  return app;
}
```

**检验标准**:

- [ ] `app.ts` < 200 行
- [ ] 所有 API 正常工作
- [ ] `pnpm test` 100% 通过
- [ ] `pnpm e2e:baseline` 通过
- [ ] 代码审查通过

---

## 实施风险与应对

| 风险         | 等级  | 描述                       | 应对措施                                                                     |
| ------------ | ----- | -------------------------- | ---------------------------------------------------------------------------- |
| 路由遗漏     | 🔴 高 | 迁移过程中遗漏某些路由     | 1. 迁移前完整列出所有路由<br>2. 每阶段结束后 API 清单比对<br>3. E2E 测试覆盖 |
| 行为不一致   | 🔴 高 | 重构后行为与原实现不一致   | 1. 保持原有业务逻辑不变<br>2. 复制原有处理代码到新控制器<br>3. 逐行比对验证  |
| 依赖注入问题 | 🟡 中 | 控制器依赖的服务实例化问题 | 1. 使用工厂模式创建服务<br>2. 在 app.ts 统一初始化服务<br>3. 确保单例模式    |
| 中间件顺序   | 🟡 中 | 路由中间件执行顺序改变     | 1. 记录原有中间件顺序<br>2. 保持相同的注册顺序<br>3. 测试验证中间件行为      |
| 性能退化     | 🟢 低 | 额外的函数调用开销         | 1. 控制器方法使用 bind<br>2. 避免箭头函数创建闭包<br>3. 基准测试对比         |

---

## 回滚方案

若出现严重问题，可快速回滚：

1. **代码回滚**: `git revert` 到重构前的提交
2. **API 验证**: 使用 Postman 集合快速验证所有 API
3. **E2E 验证**: 运行 `pnpm e2e:first-run` 验证核心流程

---

## 成功指标

| 指标             | 目标值     | 测量方式               |
| ---------------- | ---------- | ---------------------- |
| app.ts 行数      | < 200 行   | `wc -l src/app.ts`     |
| 控制器代码覆盖率 | > 80%      | `pnpm test --coverage` |
| API 响应时间     | 无显著退化 | E2E 测试计时对比       |
| 测试通过率       | 100%       | `pnpm test`            |
| E2E 通过率       | 100%       | `pnpm e2e:baseline`    |

---

## 附录: 路由完整清单

迁移前需完整列出 app.ts 中的所有路由，用于验证无遗漏。
