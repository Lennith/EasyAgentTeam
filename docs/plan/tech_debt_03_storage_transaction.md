# 技术债修复计划 3: 存储层事务与抽象

> **优先级**: P1 (高)  
> **风险等级**: 🟡 中高  
> **预计工期**: 3周  
> **目标**: 解决文件系统存储的原子性问题，创建存储抽象层，并在不改变业务逻辑的前提下提升一致性

---

## 执行状态（2026-03-26）

- 当前状态：`验证中`
- 执行策略：按“一次性切换 + 强一致事务 + 继续使用 JSON/JSONL 外部文件规格”执行，不引入数据库。
- 与 baseline 冲突项的风险接受：
  - baseline 建议“第三轮不一次性引入完整事务/WAL”；
  - 本轮按业务决策执行全量重构，接受一次性回归成本升高；
  - 通过 WAL 恢复、事务回滚、关键链路脚本验证降低风险，并保留恢复工具作为兜底。
- 业务行为兼容约束（本轮必须保持不变）：
  - HTTP API 输入/输出与错误码语义不变；
  - JSON/JSONL 文件格式与目录路径不变；
  - 事件类型与时序语义不变（如 `PROJECT_CREATED` 仍在项目创建链路中产出，迁移仅调整存储实现层次）；
  - 任务树查询、任务动作校验、排序与过滤语义不变。
- 未完成项清单（收尾批次）：
  - data 模块已大面积切到 `store-runtime`，但仍需逐项完成迁移核对与回归；
  - workflow 编排链路中仍有“状态写入 + 事件追加”未完全同事务的点位需收敛；
  - `createProject` 主链路需固定为“核心事务含 `PROJECT_CREATED` + 外部 bootstrap 后续事件”；
  - 目录级破坏操作仍有少量非事务删除路径需要改为事务删除（rename-to-trash + commit 清理）；
  - 回归门槛（`pnpm --filter @autodev/server test`、`pnpm test`、上线检测 Step 1-4）需重新完成并归档证据。
- 本次收尾目标：
  - 完成全量迁移与事务边界闭合，保持 HTTP API 语义与 JSON/JSONL 协议不变；
  - 完成关键链路（project/task/workflow）一致性验证并恢复到 `验证中`；
  - 上线检测通过后再回调到 `实装`。
- 收尾批次回归结果（2026-03-26）：
  - `pnpm --filter @autodev/server build` 通过；
  - `pnpm --filter @autodev/server test` 通过；
  - `pnpm test` 通过；
  - 当前进入上线检测前置状态，待执行 Step 1-4 后回调 `实装`。

### 本轮已落地

- 新增存储事务核心：
  - `server/src/data/storage/atomic-writer.ts`
  - `server/src/data/storage/file-lock-registry.ts`
  - `server/src/data/storage/wal-store.ts`
  - `server/src/data/storage/recovery-runner.ts`
  - `server/src/data/storage/transaction-manager.ts`
- 新增存储抽象层：
  - `server/src/data/store/store-interface.ts`
  - `server/src/data/store/errors.ts`
  - `server/src/data/store/file-store.ts`
  - `server/src/data/store/memory-store.ts`
- `file-utils` 内部已切换到事务内核，外部函数签名保持不变。
- 已将关键链路接入显式事务：
  - `project-store#createProject`（项目配置事务化；收尾批次将 `PROJECT_CREATED` 固定并入核心事务）
  - `project-store#deleteProject`（事务删除目录，避免直接硬删）
  - `task-action-service` 的 `TASK_CREATE/TASK_UPDATE/TASK_ASSIGN/TASK_REPORT`
  - `controller-routes` 的 dashboard `TASK_UPDATED` 路径

---

## 背景与问题

### 现状

当前使用文件系统存储，存在以下问题：

1. **无事务支持**: 多步骤操作无法保证原子性
2. **写入非原子**: 文件写入过程中断会导致数据损坏
3. **无索引机制**: 大数据量时性能下降
4. **难以扩展**: 无法切换到数据库存储

**典型问题代码**:

```typescript
// 旧链路示意：跨多个函数串行执行写入，缺少统一事务边界
await writeJsonFile(paths.projectConfigFile, project); // 状态写入
await appendEvent(paths, { eventType: "PROJECT_CREATED" }); // 事件追加
// 任一步骤失败都可能留下“状态/事件不同步”的中间态
```

### 目标架构

```
data/
├── store/                    # 存储抽象层
│   ├── store-interface.ts    # Store<T> 接口
│   ├── file-store.ts         # 文件存储实现
│   └── memory-store.ts       # 内存存储实现（测试用）
├── storage/                  # 事务内核
│   ├── transaction-manager.ts
│   ├── wal-store.ts
│   ├── recovery-runner.ts
│   ├── file-lock-registry.ts
│   └── atomic-writer.ts
└── file-utils.ts             # 兼容层（导出签名保持不变）
```

---

## 分阶段实施计划

### 阶段1: 存储接口设计 (2天)

**目标**: 定义通用存储接口

**改动范围**:

```
新增文件:
- server/src/data/store/store-interface.ts
- server/src/data/store/errors.ts
```

**接口设计**:

```typescript
// data/store/store-interface.ts
export interface Store<T extends { id: string }> {
  // 基础 CRUD
  get(id: string): Promise<T | null>;
  save(id: string, item: T): Promise<void>;
  delete(id: string): Promise<void>;
  list(filter?: StoreFilter<T>): Promise<T[]>;
  exists(id: string): Promise<boolean>;

  // 批量操作（原子）
  saveMany(items: Map<string, T>): Promise<void>;
  deleteMany(ids: string[]): Promise<void>;

  // 事务支持
  beginTransaction(): Promise<Transaction<T>>;

  // 元数据
  getMetadata(): Promise<StoreMetadata>;
}

export interface Transaction<T> {
  get(id: string): Promise<T | null>;
  save(id: string, item: T): void;
  delete(id: string): void;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface StoreFilter<T> {
  where?: Partial<T>;
  orderBy?: { field: keyof T; direction: "asc" | "desc" };
  limit?: number;
  offset?: number;
}

// 存储错误类型
export class StoreError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "CONFLICT" | "IO_ERROR" | "CORRUPTED",
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}
```

**检验标准**:

- [ ] 接口设计覆盖所有现有使用场景
- [ ] TypeScript 类型检查通过
- [ ] 文档注释完整

---

### 阶段2: 原子写入实现 (3天)

**目标**: 实现文件原子写入机制

**改动范围**:

```
新增文件:
- server/src/data/storage/atomic-writer.ts
- server/src/data/storage/wal-store.ts

修改文件:
- server/src/data/file-utils.ts (增强)
```

**原子写入原理**:

```typescript
// data/storage/atomic-writer.ts
export async function writeFileAtomic(filePath: string, content: string, options?: AtomicWriteOptions): Promise<void> {
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  const backupPath = `${filePath}.backup`;

  try {
    // 1. 写入临时文件
    await fs.writeFile(tempPath, content, "utf-8");

    // 2. 确保数据落盘
    await fsync(tempPath);

    // 3. 如果原文件存在，创建备份
    if (await fileExists(filePath)) {
      await fs.rename(filePath, backupPath);
    }

    // 4. 原子重命名
    await fs.rename(tempPath, filePath);

    // 5. 删除备份
    if (await fileExists(backupPath)) {
      await fs.unlink(backupPath);
    }
  } catch (error) {
    // 回滚：恢复备份
    if (await fileExists(backupPath)) {
      await fs.rename(backupPath, filePath);
    }
    throw new StoreError("Atomic write failed", "IO_ERROR", { cause: error });
  } finally {
    // 清理临时文件
    if (await fileExists(tempPath)) {
      await fs.unlink(tempPath).catch(() => {});
    }
  }
}
```

**检验标准**:

- [ ] 原子写入单元测试通过
- [ ] 故障注入测试（模拟写入中断）
- [ ] 数据完整性验证测试

---

### 阶段3: 事务管理器实现 (3天)

**目标**: 实现简单的事务支持

**改动范围**:

```
新增文件:
- server/src/data/storage/transaction-manager.ts
- server/src/data/storage/recovery-runner.ts
```

**事务管理器设计**:

```typescript
// data/storage/transaction-manager.ts
export class FileTransactionManager {
  private activeTransactions = new Map<string, Transaction<any>>();

  async beginTransaction<T>(stores: Store<T>[]): Promise<FileTransaction<T>> {
    const txId = generateTxId();
    const transaction = new FileTransaction(txId, stores);
    this.activeTransactions.set(txId, transaction);
    return transaction;
  }
}

class FileTransaction<T> implements Transaction<T> {
  private changes = new Map<string, { store: string; action: "save" | "delete"; data?: T }>();
  private committed = false;

  async commit(): Promise<void> {
    if (this.committed) throw new Error("Transaction already committed");

    // 1. 写入 WAL
    await this.writeAheadLog();

    // 2. 执行所有变更
    for (const [key, change] of this.changes) {
      await this.applyChange(change);
    }

    // 3. 清除 WAL
    await this.clearWAL();

    this.committed = true;
  }

  async rollback(): Promise<void> {
    // 回滚逻辑...
  }
}
```

**检验标准**:

- [ ] 事务提交/回滚测试通过
- [ ] 并发事务隔离测试通过
- [ ] 故障恢复测试（从 WAL 恢复）

---

### 阶段4: FileStore 实现 (3天)

**目标**: 实现基于文件的通用存储

**改动范围**:

```
新增文件:
- server/src/data/store/file-store.ts
```

**FileStore 设计**:

```typescript
// data/store/file-store.ts
export class FileStore<T extends { id: string }> implements Store<T> {
  constructor(
    private baseDir: string,
    private options: FileStoreOptions<T>
  ) {}

  async get(id: string): Promise<T | null> {
    const filePath = this.getFilePath(id);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return this.options.deserialize(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new StoreError("Read failed", "IO_ERROR", { id, cause: error });
    }
  }

  async save(id: string, item: T): Promise<void> {
    const filePath = this.getFilePath(id);
    const content = this.options.serialize(item);
    await writeFileAtomic(filePath, content);

    // 更新索引（如果启用）
    if (this.options.index) {
      await this.updateIndex(id, item);
    }
  }

  async list(filter?: StoreFilter<T>): Promise<T[]> {
    // 使用索引或遍历文件
    if (this.options.index && filter?.where) {
      return this.queryWithIndex(filter);
    }
    return this.scanAll(filter);
  }

  beginTransaction(): Promise<Transaction<T>> {
    return this.transactionManager.beginTransaction([this]);
  }
}
```

**检验标准**:

- [ ] FileStore 单元测试覆盖率 > 90%
- [ ] 与现有 file-utils 行为一致性测试
- [ ] 性能基准测试（对比现有实现）

---

### 阶段5: Project Store 迁移 (2天)

**目标**: 使用新存储层改造 project-store

**改动范围**:

```
修改文件:
- server/src/data/project-store.ts

迁移逻辑:
- createProject() 使用事务
- deleteProject() 使用事务
```

**迁移示例**:

```typescript
// data/project-store.ts (迁移后)
import { FileStore } from "./store/file-store";

const projectStore = new FileStore<ProjectRecord>({
  baseDir: path.join(dataRoot, "projects"),
  serialize: (p) => JSON.stringify(p, null, 2),
  deserialize: (s) => JSON.parse(s),
  index: ["ownerRole", "state"] // 添加索引
});

export async function createProject(input: CreateProjectInput): Promise<ProjectRecord> {
  const project = buildProject(input);

  const tx = await projectStore.beginTransaction();
  try {
    // 检查重复
    const existing = await tx.get(project.projectId);
    if (existing) {
      throw new StoreError("Project exists", "CONFLICT", { id: project.projectId });
    }

    // 原子保存
    await tx.save(project.projectId, project);

    await tx.commit();
    return project;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
// 兼容性说明：PROJECT_CREATED 事件仍由 API 创建链路写入，事件类型与对外行为不变
```

**检验标准**:

- [ ] project-store 测试全部通过
- [ ] 项目创建/删除 E2E 测试通过
- [ ] 数据一致性验证

---

### 阶段6: Task Store 迁移 (2天)

**目标**: 使用新存储层改造 taskboard-store

**改动范围**:

```
修改文件:
- server/src/data/taskboard-store.ts
```

**关键考量**:

- 任务状态转换的原子性
- 依赖关系更新的原子性
- 批量更新支持

**检验标准**:

- [ ] 任务 CRUD 测试通过
- [ ] 依赖更新测试通过
- [ ] 状态流转测试通过

---

### 阶段7: 内存存储与测试改进 (3天)

**目标**: 创建内存存储实现，改进单元测试

**改动范围**:

```
新增文件:
- server/src/data/store/memory-store.ts
- server/src/__tests__/helpers/store-test-helper.ts
```

**MemoryStore 设计**:

```typescript
// data/store/memory-store.ts
export class MemoryStore<T extends { id: string }> implements Store<T> {
  private data = new Map<string, T>();
  private indices = new Map<string, Map<any, Set<string>>>();

  async get(id: string): Promise<T | null> {
    return this.data.get(id) ?? null;
  }

  async save(id: string, item: T): Promise<void> {
    this.data.set(id, JSON.parse(JSON.stringify(item))); // 深拷贝
  }

  // ... 其他实现

  // 测试辅助方法
  clear(): void {
    this.data.clear();
  }

  dump(): T[] {
    return Array.from(this.data.values());
  }
}
```

**测试改进**:

```typescript
// 使用 MemoryStore 的测试示例
describe("ProjectService", () => {
  let store: MemoryStore<ProjectRecord>;
  let service: ProjectService;

  beforeEach(() => {
    store = new MemoryStore();
    service = new ProjectService(store);
  });

  afterEach(() => {
    store.clear();
  });

  it("should create project", async () => {
    // 纯内存测试，不依赖文件系统
  });
});
```

**检验标准**:

- [ ] MemoryStore 实现完整
- [ ] 至少 3 个核心服务改用 MemoryStore 测试
- [ ] 测试执行速度提升 > 50%

---

## 实施风险与应对

| 风险           | 等级  | 描述                   | 应对措施                                                    |
| -------------- | ----- | ---------------------- | ----------------------------------------------------------- |
| 数据格式不兼容 | 🔴 高 | 新存储层序列化格式改变 | 1. 保持 JSON 格式不变<br>2. 迁移脚本验证<br>3. 备份原始数据 |
| 性能退化       | 🔴 高 | 事务和原子写入引入开销 | 1. 基准测试对比<br>2. 批量操作优化<br>3. 异步索引更新       |
| 事务死锁       | 🟡 中 | 多 store 事务导致死锁  | 1. 统一的锁顺序<br>2. 事务超时机制<br>3. 死锁检测           |
| WAL 膨胀       | 🟡 中 | 事务日志文件无限增长   | 1. 定期清理 WAL<br>2. 提交后删除日志<br>3. 压缩归档         |
| 索引不一致     | 🟡 中 | 索引与实际数据不一致   | 1. 索引重建工具<br>2. 一致性校验任务<br>3. 自动修复         |

---

## 数据迁移方案

### 兼容性保证

- 保持 JSON 文件格式不变
- 文件路径不变
- 新存储层读取旧格式无需转换

### 回滚方案

1. 不保留长期新旧双栈；统一走新事务内核
2. 通过 WAL 恢复器 + 目录快照回滚应急（工具化）
3. 保留只读迁移/巡检工具用于排障，不作为运行时双写路径

---

## 成功指标

| 指标           | 目标值     | 测量方式       |
| -------------- | ---------- | -------------- |
| 存储操作原子性 | 100%       | 故障注入测试   |
| 数据损坏率     | 0%         | 数据完整性校验 |
| 测试执行速度   | 提升 > 50% | 对比基准       |
| 存储层覆盖率   | > 85%      | 测试覆盖率报告 |
| 向后兼容       | 100%       | 旧数据读取测试 |

---

## 附录: 存储操作清单

已纳入 `storage-transaction` 相关测试用例，后续按失败项持续补充。
