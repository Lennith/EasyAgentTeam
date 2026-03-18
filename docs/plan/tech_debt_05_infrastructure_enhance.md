# 技术债修复计划 5: 基础设施增强

> **优先级**: P2 (中)  
> **风险等级**: 🟢 中低  
> **预计工期**: 1-2周  
> **目标**: 改进日志系统和配置管理

---

## 背景与问题

### 日志系统现状

```typescript
// logger.ts - 当前实现简单
export const logger = new Logger();

// 问题:
// 1. 无日志级别控制（DEBUG/INFO/WARN/ERROR）
// 2. 无结构化日志（纯文本格式）
// 3. 无日志轮转（单文件无限增长）
// 4. 无上下文追踪（requestId 等）
// 5. 无性能指标记录
```

### 配置管理现状

```typescript
// 配置分散在多个文件:
- runtime-settings-store.ts      # 运行时设置
- 环境变量 FRAMEWORK_DATA_ROOT   # 数据根目录
- project-store.ts               # 项目级配置
- minimax/config.ts              # MiniMax 配置
```

**问题**:

- 配置来源不透明
- 无配置验证
- 无配置热重载
- 环境变量与代码配置混用

---

## 分阶段实施计划

### 阶段1: 结构化日志系统 (3天)

**目标**: 实现 JSON 结构化日志

**改动范围**:

```
新增文件:
- server/src/infrastructure/logger/types.ts
- server/src/infrastructure/logger/structured-logger.ts
- server/src/infrastructure/logger/log-level.ts

修改文件:
- server/src/logger.ts (重构)
```

**日志接口设计**:

```typescript
// infrastructure/logger/types.ts
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  metadata?: Record<string, unknown>;
}

export interface LogContext {
  requestId?: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  role?: string;
  userId?: string;
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

export interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, error?: Error, metadata?: Record<string, unknown>): void;
  fatal(message: string, error?: Error, metadata?: Record<string, unknown>): void;

  // 创建子 logger（继承上下文）
  child(context: LogContext): Logger;

  // 设置上下文
  setContext(context: LogContext): void;
}
```

**结构化日志实现**:

```typescript
// infrastructure/logger/structured-logger.ts
export class StructuredLogger implements Logger {
  private context: LogContext = {};

  constructor(
    private options: LoggerOptions,
    private writers: LogWriter[]
  ) {}

  info(message: string, metadata?: Record<string, unknown>): void {
    this.log("INFO", message, metadata);
  }

  error(message: string, error?: Error, metadata?: Record<string, unknown>): void {
    this.log("ERROR", message, {
      ...metadata,
      error: error
        ? {
            message: error.message,
            stack: error.stack,
            code: (error as { code?: string }).code
          }
        : undefined
    });
  }

  private log(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: this.context,
      metadata
    };

    for (const writer of this.writers) {
      writer.write(entry);
    }
  }

  child(context: LogContext): Logger {
    const childLogger = new StructuredLogger(this.options, this.writers);
    childLogger.setContext({ ...this.context, ...context });
    return childLogger;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"];
    return levels.indexOf(level) >= levels.indexOf(this.options.minLevel);
  }
}
```

**文件日志写入器（带轮转）**:

```typescript
// infrastructure/logger/file-writer.ts
export class RotatingFileWriter implements LogWriter {
  private currentFile: string;
  private currentSize = 0;

  constructor(
    private basePath: string,
    private options: {
      maxSize: number; // 单个文件最大大小
      maxFiles: number; // 保留文件数量
      datePattern: string; // 日期格式
    }
  ) {
    this.currentFile = this.generateFilePath();
  }

  write(entry: LogEntry): void {
    const line = JSON.stringify(entry) + "\n";
    const lineSize = Buffer.byteLength(line, "utf-8");

    if (this.currentSize + lineSize > this.options.maxSize) {
      this.rotate();
    }

    fs.appendFileSync(this.currentFile, line);
    this.currentSize += lineSize;
  }

  private rotate(): void {
    // 关闭当前文件，创建新文件
    // 清理旧文件...
  }
}
```

**检验标准**:

- [ ] 日志输出为 JSON 格式
- [ ] 支持 DEBUG/INFO/WARN/ERROR 级别
- [ ] 日志轮转正常工作
- [ ] 上下文追踪正常工作

---

### 阶段2: 日志集成 (2天)

**目标**: 将新日志系统集成到应用中

**改动范围**:

```
修改文件:
- server/src/app.ts (请求上下文注入)
- server/src/services/*.ts (使用新 logger)
- server/src/minimax/*.ts (使用新 logger)
```

**请求上下文注入**:

```typescript
// middleware/request-context.ts
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.headers["x-request-id"] || generateRequestId();

  // 创建带上下文的 logger
  const requestLogger = logger.child({ requestId });

  // 附加到请求
  req.logger = requestLogger;
  req.requestId = requestId;

  // 记录请求开始
  requestLogger.info("Request started", {
    method: req.method,
    path: req.path,
    query: req.query
  });

  // 记录响应时间
  const startTime = Date.now();
  res.on("finish", () => {
    requestLogger.info("Request completed", {
      statusCode: res.statusCode,
      durationMs: Date.now() - startTime
    });
  });

  next();
}
```

**服务中使用**:

```typescript
// services/orchestrator-service.ts
export class OrchestratorService {
  private logger = logger.child({ service: "OrchestratorService" });

  async dispatch(projectId: string): Promise<void> {
    const dispatchLogger = this.logger.child({ projectId });

    dispatchLogger.info("Dispatch started");

    try {
      // ... 调度逻辑
      dispatchLogger.info("Dispatch completed", { taskCount });
    } catch (error) {
      dispatchLogger.error("Dispatch failed", error as Error);
      throw error;
    }
  }
}
```

**检验标准**:

- [ ] 每个请求都有 requestId
- [ ] 日志中包含项目/会话/任务上下文
- [ ] 错误日志包含完整堆栈

---

### 阶段3: 统一配置管理 (3天)

**目标**: 创建统一的配置管理系统

**改动范围**:

```
新增文件:
- server/src/config/app-config.ts
- server/src/config/config-schema.ts
- server/src/config/config-loader.ts
- server/src/config/sources/env-source.ts
- server/src/config/sources/file-source.ts
```

**配置架构**:

```typescript
// config/config-schema.ts
import { z } from "zod";

export const AppConfigSchema = z.object({
  // 服务器配置
  server: z.object({
    port: z.number().default(43123),
    host: z.string().default("127.0.0.1"),
    corsOrigins: z.array(z.string()).default(["http://localhost:5173"])
  }),

  // 数据存储配置
  data: z.object({
    rootDir: z.string().default("./data"),
    backupEnabled: z.boolean().default(true),
    backupIntervalHours: z.number().default(24)
  }),

  // 日志配置
  logging: z.object({
    level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).default("INFO"),
    format: z.enum(["json", "text"]).default("json"),
    fileRotation: z.object({
      enabled: z.boolean().default(true),
      maxSizeMb: z.number().default(100),
      maxFiles: z.number().default(10)
    })
  }),

  // 编排器配置
  orchestrator: z.object({
    tickIntervalMs: z.number().default(1000),
    maxConcurrentDispatches: z.number().default(5),
    sessionTimeoutMinutes: z.number().default(30),
    reminder: z.object({
      initialWaitMinutes: z.number().default(1),
      backoffMultiplier: z.number().default(2),
      maxWaitMinutes: z.number().default(10)
    })
  }),

  // MiniMax 配置
  minimax: z.object({
    apiKey: z.string().optional(),
    apiBase: z.string().default("https://api.minimax.chat"),
    defaultModel: z.string().default("abab6.5s-chat"),
    maxTokens: z.number().default(4096)
  })
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
```

**配置加载器**:

```typescript
// config/config-loader.ts
export class ConfigLoader {
  private sources: ConfigSource[] = [];

  addSource(source: ConfigSource): this {
    this.sources.push(source);
    return this;
  }

  async load(): Promise<AppConfig> {
    const rawConfig: Record<string, unknown> = {};

    // 按优先级合并配置
    for (const source of this.sources) {
      const config = await source.load();
      deepMerge(rawConfig, config);
    }

    // 验证配置
    const result = AppConfigSchema.safeParse(rawConfig);
    if (!result.success) {
      throw new ConfigValidationError(result.error);
    }

    return result.data;
  }
}

// 使用
const config = await new ConfigLoader()
  .addSource(new FileSource("./config/default.yaml"))
  .addSource(new FileSource("./config/local.yaml", { optional: true }))
  .addSource(new EnvSource({ prefix: "FRAMEWORK_" }))
  .load();
```

**环境变量源**:

```typescript
// config/sources/env-source.ts
export class EnvSource implements ConfigSource {
  constructor(private options: { prefix?: string } = {}) {}

  async load(): Promise<Record<string, unknown>> {
    const config: Record<string, unknown> = {};
    const prefix = this.options.prefix || "";

    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith(prefix)) continue;

      const path = key.slice(prefix.length).toLowerCase().split("_");

      setValueAtPath(config, path, this.parseValue(value));
    }

    return config;
  }

  private parseValue(value: string): unknown {
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}
```

**检验标准**:

- [ ] 配置从统一入口加载
- [ ] 配置验证失败给出清晰错误
- [ ] 环境变量映射正确
- [ ] 配置类型推断正常工作

---

### 阶段4: 配置集成 (2天)

**目标**: 使用新配置系统替换分散配置

**改动范围**:

```
修改文件:
- server/src/index.ts (配置初始化)
- server/src/app.ts (使用配置)
- server/src/services/orchestrator-service.ts (使用配置)
- server/src/minimax/minimax-client.ts (使用配置)
```

**全局配置访问**:

```typescript
// config/index.ts
let globalConfig: AppConfig;

export async function initializeConfig(): Promise<void> {
  globalConfig = await new ConfigLoader().addSource(new EnvSource({ prefix: "FRAMEWORK_" })).load();
}

export function getConfig(): AppConfig {
  if (!globalConfig) {
    throw new Error("Config not initialized");
  }
  return globalConfig;
}

// 便利函数
export function getServerConfig() {
  return getConfig().server;
}
export function getLoggingConfig() {
  return getConfig().logging;
}
export function getOrchestratorConfig() {
  return getConfig().orchestrator;
}
```

**替换原有配置**:

```typescript
// 修改前
const tickInterval = parseInt(process.env.ORCHESTRATOR_TICK_INTERVAL || "1000", 10);

// 修改后
import { getOrchestratorConfig } from "../config";
const tickInterval = getOrchestratorConfig().tickIntervalMs;
```

**检验标准**:

- [ ] 所有环境变量使用都迁移到新配置
- [ ] 配置验证在启动时完成
- [ ] 配置热重载支持（可选）

---

## 实施风险与应对

| 风险         | 等级  | 描述                         | 应对措施                                          |
| ------------ | ----- | ---------------------------- | ------------------------------------------------- |
| 日志格式破坏 | 🔴 高 | JSON 格式改变下游日志处理    | 1. 提供格式转换工具<br>2. 灰度切换<br>3. 文档说明 |
| 配置不兼容   | 🟡 中 | 新配置系统与旧环境变量不兼容 | 1. 配置映射表<br>2. 启动验证<br>3. 错误提示       |
| 性能影响     | 🟢 低 | 日志序列化引入 CPU 开销      | 1. 异步写入<br>2. 批量写入<br>3. 采样记录         |
| 磁盘空间     | 🟢 低 | JSON 日志体积大于纯文本      | 1. 日志压缩<br>2. 更激进的轮转<br>3. 分级存储     |

---

## 成功指标

| 指标         | 目标值     | 测量方式               |
| ------------ | ---------- | ---------------------- |
| 日志结构化率 | 100%       | 日志文件 JSON 格式验证 |
| 配置集中率   | 100%       | 代码审查               |
| 启动配置验证 | 100%       | 集成测试               |
| 日志查询效率 | 提升 > 50% | 结构化查询对比 grep    |
| 配置错误发现 | 启动时     | 启动失败给出明确错误   |

---

## 附录: 环境变量迁移表

| 旧环境变量          | 新配置路径      | 说明             |
| ------------------- | --------------- | ---------------- |
| FRAMEWORK_DATA_ROOT | data.rootDir    | 数据根目录       |
| FRAMEWORK_PORT      | server.port     | 服务器端口       |
| FRAMEWORK_LOG_LEVEL | logging.level   | 日志级别         |
| MINIMAX_API_KEY     | minimax.apiKey  | MiniMax API Key  |
| MINIMAX_API_BASE    | minimax.apiBase | MiniMax API 地址 |
