# 技术债修复计划 6: 测试与文档改进

> **优先级**: P2 (中)  
> **风险等级**: 🟢 低  
> **预计工期**: 持续进行  
> **目标**: 提升测试质量，补充 API 文档，改进代码可维护性

---

## 背景与问题

### 测试现状

```typescript
// 当前测试依赖文件系统 - 非纯单元测试
import { createProject } from "../data/project-store";

test("should create project", async () => {
  const tempDir = await mkdtemp("test-");
  // 依赖实际文件系统操作
  const project = await createProject({
    projectId: "test",
    workspacePath: tempDir
  });
  // 测试后需要清理文件
});

// 问题:
// 1. 测试速度慢（IO 操作）
// 2. 测试不稳定（文件系统并发）
// 3. 测试隔离困难
// 4. 难以并行执行
```

### 文档现状

- 无 OpenAPI/Swagger 定义
- API 契约只能通过代码阅读
- 缺少架构决策记录 (ADR)
- 代码注释覆盖率 < 30%

---

## 分阶段实施计划

### 阶段1: 内存存储实现 (3天)

**目标**: 创建 `MemoryStore<T>` 用于测试

**改动范围**:

```
新增文件:
- server/src/__tests__/helpers/memory-store.ts
- server/src/__tests__/helpers/test-factory.ts
- server/src/__tests__/helpers/test-data-builder.ts
```

**MemoryStore 完整实现**:

```typescript
// __tests__/helpers/memory-store.ts
import { Store, StoreFilter, Transaction } from "../../data/store/store-interface";

export class MemoryStore<T extends { id: string }> implements Store<T> {
  private data = new Map<string, T>();
  private indices = new Map<string, Map<unknown, Set<string>>>();

  constructor(private options?: { indexFields?: (keyof T)[] }) {
    this.setupIndices();
  }

  async get(id: string): Promise<T | null> {
    const item = this.data.get(id);
    return item ? this.clone(item) : null;
  }

  async save(id: string, item: T): Promise<void> {
    const cloned = this.clone(item);
    const oldItem = this.data.get(id);

    // 更新索引
    if (oldItem) {
      this.removeFromIndices(id, oldItem);
    }
    this.addToIndices(id, cloned);

    this.data.set(id, cloned);
  }

  async delete(id: string): Promise<void> {
    const item = this.data.get(id);
    if (item) {
      this.removeFromIndices(id, item);
      this.data.delete(id);
    }
  }

  async list(filter?: StoreFilter<T>): Promise<T[]> {
    let items = Array.from(this.data.values());

    if (filter?.where) {
      items = items.filter((item) => this.matchesFilter(item, filter.where!));
    }

    if (filter?.orderBy) {
      items.sort((a, b) => this.compare(a, b, filter.orderBy!));
    }

    if (filter?.offset) {
      items = items.slice(filter.offset);
    }

    if (filter?.limit) {
      items = items.slice(0, filter.limit);
    }

    return items.map((item) => this.clone(item));
  }

  async exists(id: string): Promise<boolean> {
    return this.data.has(id);
  }

  beginTransaction(): Promise<Transaction<T>> {
    return Promise.resolve(new MemoryTransaction(this));
  }

  // 测试辅助方法
  clear(): void {
    this.data.clear();
    this.indices.clear();
    this.setupIndices();
  }

  dump(): T[] {
    return Array.from(this.data.values()).map((item) => this.clone(item));
  }

  size(): number {
    return this.data.size;
  }

  private clone(item: T): T {
    return JSON.parse(JSON.stringify(item));
  }

  // ... 索引管理方法
}
```

**测试数据构建器**:

```typescript
// __tests__/helpers/test-data-builder.ts
export class ProjectBuilder {
  private data: Partial<ProjectRecord> = {
    projectId: "test-project",
    name: "Test Project",
    state: "ACTIVE",
    createdAt: new Date().toISOString()
  };

  withId(id: string): this {
    this.data.projectId = id;
    return this;
  }

  withName(name: string): this {
    this.data.name = name;
    return this;
  }

  withWorkspace(path: string): this {
    this.data.workspacePath = path;
    return this;
  }

  build(): ProjectRecord {
    return this.data as ProjectRecord;
  }
}

export class TaskBuilder {
  private data: Partial<TaskRecord> = {
    taskId: "test-task",
    title: "Test Task",
    state: "PLANNED",
    taskKind: "EXECUTION",
    ownerRole: "dev"
  };

  withId(id: string): this {
    this.data.taskId = id;
    return this;
  }

  withState(state: TaskState): this {
    this.data.state = state;
    return this;
  }

  withOwner(role: string): this {
    this.data.ownerRole = role;
    return this;
  }

  withDependencies(ids: string[]): this {
    this.data.dependencies = ids;
    return this;
  }

  build(): TaskRecord {
    return this.data as TaskRecord;
  }
}
```

**检验标准**:

- [ ] MemoryStore 实现完整 Store 接口
- [ ] MemoryStore 单元测试覆盖率 100%
- [ ] 性能对比：MemoryStore vs FileStore > 10x 提升

---

### 阶段2: 核心服务测试重构 (持续)

**目标**: 使用 MemoryStore 重写关键服务测试

**改动范围**:

```
重构测试文件:
- server/src/__tests__/project-store.test.ts
- server/src/__tests__/taskboard-store.test.ts
- server/src/__tests__/orchestrator-dispatch-core.test.ts
- server/src/__tests__/task-actions.test.ts
```

**测试重构示例**:

```typescript
// project-store.test.ts (重构后)
import { MemoryStore } from "./helpers/memory-store";
import { ProjectBuilder } from "./helpers/test-data-builder";

describe("ProjectStore (with MemoryStore)", () => {
  let store: MemoryStore<ProjectRecord>;
  let projectService: ProjectService;

  beforeEach(() => {
    store = new MemoryStore<ProjectRecord>();
    projectService = new ProjectService(store);
  });

  afterEach(() => {
    store.clear();
  });

  test("should create project", async () => {
    const input = new ProjectBuilder().withId("proj-1").withName("My Project").build();

    const project = await projectService.createProject(input);

    expect(project.projectId).toBe("proj-1");
    expect(await store.get("proj-1")).toEqual(project);
  });

  test("should not create duplicate project", async () => {
    const input = new ProjectBuilder().withId("proj-1").build();
    await projectService.createProject(input);

    await expect(projectService.createProject(input)).rejects.toThrow("Project already exists");
  });

  test("should list projects", async () => {
    await projectService.createProject(new ProjectBuilder().withId("proj-1").build());
    await projectService.createProject(new ProjectBuilder().withId("proj-2").build());

    const projects = await projectService.listProjects();

    expect(projects).toHaveLength(2);
  });
});
```

**检验标准**:

- [ ] 重构后测试执行时间 < 1s（原 > 5s）
- [ ] 测试稳定性 100%（无 flaky tests）
- [ ] 代码覆盖率无下降

---

### 阶段3: OpenAPI 文档 (3天)

**目标**: 生成 OpenAPI/Swagger 规范

**改动范围**:

```
新增文件:
- server/src/openapi/openapi-generator.ts
- server/src/openapi/schemas/project-schema.ts
- server/src/openapi/schemas/task-schema.ts
- server/src/openapi/paths/projects.ts
- server/src/openapi/paths/tasks.ts

修改文件:
- server/src/app.ts (添加 Swagger UI)
```

**OpenAPI Schema 定义**:

```typescript
// openapi/schemas/project-schema.ts
export const ProjectSchema = {
  type: "object",
  properties: {
    projectId: { type: "string", description: "Unique project identifier" },
    name: { type: "string", description: "Project display name" },
    description: { type: "string", description: "Project description" },
    state: {
      type: "string",
      enum: ["ACTIVE", "ARCHIVED"],
      description: "Project state"
    },
    workspacePath: { type: "string", description: "Absolute path to workspace" },
    autoDispatchEnabled: { type: "boolean" },
    autoDispatchRemaining: { type: "integer" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" }
  },
  required: ["projectId", "name", "state", "createdAt"]
} as const;

export const CreateProjectRequestSchema = {
  type: "object",
  properties: {
    projectId: { type: "string", pattern: "^[a-z0-9_-]+$", maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 1000 },
    workspacePath: { type: "string" },
    autoDispatchEnabled: { type: "boolean", default: false },
    autoDispatchRemaining: { type: "integer", minimum: 0, default: 0 }
  },
  required: ["projectId", "name"]
} as const;
```

**路径定义**:

```typescript
// openapi/paths/projects.ts
export const projectsPaths = {
  "/api/projects": {
    get: {
      summary: "List all projects",
      operationId: "listProjects",
      responses: {
        "200": {
          description: "List of projects",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/Project" }
              }
            }
          }
        }
      }
    },
    post: {
      summary: "Create a new project",
      operationId: "createProject",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateProjectRequest" }
          }
        }
      },
      responses: {
        "201": {
          description: "Project created",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Project" }
            }
          }
        },
        "409": {
          description: "Project already exists",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" }
            }
          }
        }
      }
    }
  }
  // ... 更多路径
};
```

**集成 Swagger UI**:

```typescript
// app.ts
import swaggerUi from "swagger-ui-express";
import { generateOpenAPISpec } from "./openapi/openapi-generator";

const openApiSpec = generateOpenAPISpec();

app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));
app.get("/api/openapi.json", (req, res) => {
  res.json(openApiSpec);
});
```

**检验标准**:

- [ ] 所有 API 都有 OpenAPI 定义
- [ ] Swagger UI 可访问 (`/api/docs`)
- [ ] 客户端 SDK 可生成

---

### 阶段4: 代码文档化 (持续)

**目标**: 为所有公共 API 添加 JSDoc

**改动范围**:

```
所有文件:
- server/src/controllers/*.ts
- server/src/services/*.ts
- server/src/data/*.ts
```

**JSDoc 示例**:

````typescript
/**
 * Creates a new project with the specified configuration.
 *
 * @param input - Project creation parameters
 * @param input.projectId - Unique identifier for the project (alphanumeric, hyphens, underscores)
 * @param input.name - Display name for the project
 * @param input.workspacePath - Optional absolute path to workspace directory
 * @param input.autoDispatchEnabled - Whether auto-dispatch is enabled (default: false)
 * @returns The created project record
 * @throws {StoreError} If projectId already exists
 * @throws {ValidationError} If input validation fails
 *
 * @example
 * ```typescript
 * const project = await createProject({
 *   projectId: 'my-project',
 *   name: 'My Project',
 *   autoDispatchEnabled: true
 * });
 * ```
 */
export async function createProject(input: CreateProjectInput): Promise<ProjectRecord> {
  // ... implementation
}

/**
 * Dispatches tasks to available sessions in a project.
 *
 * This is the core scheduling function that:
 * 1. Checks for runnable tasks
 * 2. Resolves target sessions for each role
 * 3. Dispatches messages to idle sessions
 * 4. Handles timeouts and retries
 *
 * @param projectId - The project to dispatch for
 * @param options - Dispatch options
 * @param options.force - Force dispatch even if session is busy
 * @param options.onlyIdle - Only dispatch to idle sessions
 * @returns Array of dispatch results per session
 */
export async function dispatchProject(projectId: string, options?: DispatchOptions): Promise<DispatchResult[]> {
  // ... implementation
}
````

**TypeDoc 配置**:

```json
// typedoc.json
{
  "entryPoints": ["src/index.ts"],
  "out": "docs/api",
  "exclude": ["**/*.test.ts", "**/__tests__/**"],
  "theme": "default",
  "name": "EasyAgentTeam API",
  "readme": "README.md"
}
```

**检验标准**:

- [ ] 公共函数 JSDoc 覆盖率 > 90%
- [ ] TypeDoc 文档可生成
- [ ] 示例代码可运行

---

### 阶段5: ADR 文档 (2天)

**目标**: 记录架构决策

**改动范围**:

```
新增文件:
- docs/adr/001-file-storage.md
- docs/adr/002-minimax-integration.md
- docs/adr/003-task-state-machine.md
- docs/adr/004-session-lifecycle.md
- docs/adr/005-orchestrator-design.md
```

**ADR 模板**:

```markdown
# ADR 001: File System Storage

## Status

Accepted

## Context

需要选择项目的持久化存储方案。

考虑选项:

1. SQLite - 关系型数据库，支持事务
2. JSON 文件 - 简单，易于调试
3. MongoDB - 文档数据库，灵活

## Decision

选择 JSON 文件存储。

理由:

- 个人项目，数据量小
- 易于调试和手动修复
- 版本控制友好
- 无额外依赖

## Consequences

优点:

- 实现简单
- 透明可审计

缺点:

- 无事务支持
- 性能受限
- 并发能力弱

## Related

- 计划3: 存储层事务与抽象
```

**检验标准**:

- [ ] 核心架构决策都有 ADR
- [ ] ADR 与代码实现一致

---

## 实施风险与应对

| 风险           | 等级  | 描述                  | 应对措施                                                     |
| -------------- | ----- | --------------------- | ------------------------------------------------------------ |
| 文档过时       | 🟡 中 | 代码修改后文档未更新  | 1. 代码审查强制检查<br>2. CI 验证文档同步<br>3. 定期文档审查 |
| 测试覆盖下降   | 🟡 中 | 重构测试时遗漏场景    | 1. 保持原有测试通过<br>2. 对比覆盖率报告<br>3. 变异测试      |
| OpenAPI 不准确 | 🟢 低 | 定义与实际 API 不一致 | 1. 从代码生成 OpenAPI<br>2. 运行时验证<br>3. 契约测试        |

---

## 成功指标

| 指标             | 目标值 | 测量方式     |
| ---------------- | ------ | ------------ |
| 内存存储测试占比 | > 60%  | 代码统计     |
| 测试执行时间     | < 30s  | `pnpm test`  |
| JSDoc 覆盖率     | > 90%  | TypeDoc 生成 |
| OpenAPI 完整度   | 100%   | 路径覆盖率   |
| ADR 数量         | > 5    | 文档统计     |

---

## 附录: 测试迁移检查清单

待逐文件迁移时记录进度。
