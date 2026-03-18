# 技术债修复计划 4: 错误处理与类型安全

> **优先级**: P1 (高)  
> **风险等级**: 🟡 中  
> **预计工期**: 2周  
> **目标**: 统一错误处理，消除 any 使用，增强运行时类型校验

---

## 背景与问题

### 现状问题

#### 1. any 使用泛滥

```typescript
// minimax/tools/index.ts
const shellToolAny = shellTool as any;
if (typeof shellToolAny.cleanupAll === "function") {
  shellToolAny.cleanupAll();
}

// data/file-utils.ts
const known = error as NodeJS.ErrnoException;
```

#### 2. 错误处理不一致

```typescript
// 方式1: 抛出异常
throw new TaskActionError("Invalid action", "TASK_ACTION_INVALID");

// 方式2: 返回错误对象
return { success: false, error: "Invalid action" };

// 方式3: 直接忽略
} catch (e) {
  // ignore
}

// 方式4: 返回 null
return null;
```

#### 3. 缺少运行时类型校验

```typescript
// 请求参数无校验
app.post("/api/projects", async (req, res) => {
  const input = req.body; // 任何类型都可以
  const project = await createProject(input); // 可能在内部才报错
});
```

### 目标

- 消除 90% 以上的 `any` 使用
- 统一错误响应格式
- 关键 API 入口运行时类型校验
- 完善的错误上下文信息

---

## 分阶段实施计划

### 阶段1: any 使用审计 (1天)

**目标**: 完整列出所有 any 使用情况

**改动范围**:

```
新增文件:
- docs/plan/any-usage-audit.md

分析命令:
- grep -r "as any" server/src --include="*.ts"
- grep -r ": any" server/src --include="*.ts" | grep -v "test"
- grep -r "// @ts-ignore" server/src --include="*.ts"
```

**审计输出格式**:

```markdown
## any 使用清单

### 高优先级修复 (核心业务逻辑)

| 文件                   | 行号 | 代码                                     | 建议修复           |
| ---------------------- | ---- | ---------------------------------------- | ------------------ |
| minimax/tools/index.ts | 45   | `const shellToolAny = shellTool as any;` | 扩展 Tool 接口定义 |
| data/file-utils.ts     | 123  | `error as NodeJS.ErrnoException`         | 使用类型守卫       |

### 中优先级修复 (工具函数)

...

### 低优先级修复 (测试文件)

...
```

**检验标准**:

- [ ] 完整列出所有 `any` 使用（目标 < 50 处）
- [ ] 按优先级分类
- [ ] 制定每处修复方案

---

### 阶段2: 类型守卫与工具 (2天)

**目标**: 创建类型守卫工具库

**改动范围**:

```
新增文件:
- server/src/utils/type-guards.ts
- server/src/utils/error-type-guards.ts
- server/src/types/runtime-types.ts
```

**类型守卫实现**:

```typescript
// utils/type-guards.ts
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

export function hasProperty<T extends string>(obj: unknown, prop: T): obj is Record<T, unknown> {
  return typeof obj === "object" && obj !== null && prop in obj;
}

// 用于动态方法检查
type WithMethod<K extends string> = Record<K, (...args: unknown[]) => unknown>;

export function hasMethod<T extends string>(obj: unknown, methodName: T): obj is WithMethod<T> {
  return hasProperty(obj, methodName) && typeof obj[methodName] === "function";
}
```

**错误类型守卫**:

```typescript
// utils/error-type-guards.ts
export function isTaskActionError(error: unknown): error is TaskActionError {
  return error instanceof TaskActionError;
}

export function isStoreError(error: unknown): error is StoreError {
  return error instanceof StoreError;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

export function getErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}
```

**检验标准**:

- [ ] 类型守卫单元测试覆盖率 100%
- [ ] 类型守卫被成功应用到 3+ 处代码

---

### 阶段3: any 清理 - 基础设施层 (2天)

**目标**: 清理 `minimax/` 和 `data/` 目录的 any 使用

**改动范围**:

```
修改文件:
- server/src/minimax/tools/index.ts
- server/src/minimax/minimax-runner.ts
- server/src/data/file-utils.ts
- server/src/data/json-utils.ts
```

**修复示例**:

```typescript
// 修复前 (minimax/tools/index.ts)
const shellToolAny = shellTool as any;
if (typeof shellToolAny.cleanupAll === "function") {
  shellToolAny.cleanupAll();
}

// 修复后
import { hasMethod } from "../../utils/type-guards";

if (hasMethod(shellTool, "cleanupAll")) {
  shellTool.cleanupAll();
}

// 或者扩展接口定义
interface ToolWithCleanup extends Tool {
  cleanupAll(): void;
}

function isToolWithCleanup(tool: Tool): tool is ToolWithCleanup {
  return "cleanupAll" in tool && typeof (tool as ToolWithCleanup).cleanupAll === "function";
}
```

**检验标准**:

- [ ] minimax/ 目录 any 使用减少 > 80%
- [ ] data/ 目录 any 使用减少 > 80%
- [ ] 相关测试全部通过

---

### 阶段4: any 清理 - 服务层 (2天)

**目标**: 清理 `services/` 目录的 any 使用

**改动范围**:

```
修改文件:
- server/src/services/*.ts (所有服务文件)
```

**重点关注**:

- orchestrator-service.ts
- workflow-orchestrator-service.ts
- task-action-service.ts
- manager-message-service.ts

**检验标准**:

- [ ] services/ 目录 any 使用减少 > 70%
- [ ] 所有服务测试通过

---

### 阶段5: 统一错误响应格式 (2天)

**目标**: 创建并应用统一的 API 错误响应格式

**改动范围**:

```
新增文件:
- server/src/errors/api-error.ts
- server/src/errors/api-response.ts
- server/src/middleware/error-handler.ts

修改文件:
- server/src/app.ts (注册错误处理中间件)
```

**错误响应标准**:

```typescript
// errors/api-response.ts
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    hint?: string;
    requestId?: string;
    timestamp: string;
  };
}

export interface ApiSuccessResponse<T> {
  data: T;
  meta?: {
    requestId: string;
    timestamp: string;
  };
}

// 错误代码枚举
export const ErrorCodes = {
  // 通用错误
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",

  // 项目相关
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  PROJECT_ALREADY_EXISTS: "PROJECT_ALREADY_EXISTS",

  // 任务相关
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TASK_ACTION_INVALID: "TASK_ACTION_INVALID",
  TASK_DEPENDENCY_CYCLE: "TASK_DEPENDENCY_CYCLE",

  // 会话相关
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_CONFLICT: "SESSION_CONFLICT",

  // 编排器相关
  DISPATCH_FAILED: "DISPATCH_FAILED",
  ORCHESTRATOR_BUSY: "ORCHESTRATOR_BUSY"
} as const;
```

**错误处理中间件**:

```typescript
// middleware/error-handler.ts
export function errorHandler(error: Error, req: Request, res: Response, next: NextFunction): void {
  const requestId = req.headers["x-request-id"] || generateRequestId();

  // 记录错误
  logger.error("API Error", {
    requestId,
    error: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method
  });

  // 转换为标准响应
  const response = convertErrorToResponse(error, requestId as string);

  res.status(getHttpStatusForError(error)).json(response);
}

function convertErrorToResponse(error: Error, requestId: string): ApiErrorResponse {
  if (error instanceof TaskActionError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
        requestId,
        timestamp: new Date().toISOString()
      }
    };
  }

  if (error instanceof StoreError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        requestId,
        timestamp: new Date().toISOString()
      }
    };
  }

  // 默认错误
  return {
    error: {
      code: ErrorCodes.INTERNAL_ERROR,
      message: "Internal server error",
      requestId,
      timestamp: new Date().toISOString()
    }
  };
}
```

**检验标准**:

- [ ] 所有 API 错误响应遵循统一格式
- [ ] 错误包含 requestId 便于追踪
- [ ] 错误处理中间件单元测试通过

---

### 阶段6: 运行时类型校验 (2天)

**目标**: 在关键 API 入口添加 Zod 校验

**改动范围**:

```
新增文件:
- server/src/validation/schemas.ts
- server/src/validation/project-schema.ts
- server/src/validation/task-schema.ts
- server/src/middleware/validation-middleware.ts

修改文件:
- server/src/app.ts (主要 POST/PUT 路由)
```

**Zod Schema 定义**:

```typescript
// validation/project-schema.ts
import { z } from "zod";

export const CreateProjectSchema = z.object({
  projectId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_-]+$/i),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  workspacePath: z.string().optional(),
  autoDispatchEnabled: z.boolean().default(false),
  autoDispatchRemaining: z.number().int().min(0).default(0)
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

// validation/task-schema.ts
export const TaskActionSchema = z.object({
  actionType: z.enum(["TASK_CREATE", "TASK_UPDATE", "TASK_REPORT", "TASK_ASSIGN"]),
  fromAgent: z.string(),
  fromSessionId: z.string(),
  taskId: z.string()
  // ... 其他字段
});
```

**验证中间件**:

```typescript
// middleware/validation-middleware.ts
import { z } from "zod";

export function validateBody<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          message: "Request body validation failed",
          details: result.error.flatten(),
          timestamp: new Date().toISOString()
        }
      });
      return;
    }

    // 将解析后的数据附加到请求
    req.validatedBody = result.data;
    next();
  };
}

// 类型扩展
declare global {
  namespace Express {
    interface Request {
      validatedBody?: unknown;
    }
  }
}
```

**应用校验**:

```typescript
// app.ts 中使用
import { CreateProjectSchema } from "./validation/project-schema";
import { validateBody } from "./middleware/validation-middleware";

app.post("/api/projects", validateBody(CreateProjectSchema), async (req, res) => {
  const input = req.validatedBody as CreateProjectInput;
  const project = await createProject(input);
  res.status(201).json(project);
});
```

**检验标准**:

- [ ] 主要 POST/PUT API 都有 Zod 校验
- [ ] 校验错误返回 400 和详细错误信息
- [ ] 类型推断正常工作

---

## 实施风险与应对

| 风险           | 等级  | 描述                             | 应对措施                                                      |
| -------------- | ----- | -------------------------------- | ------------------------------------------------------------- |
| 类型过度约束   | 🔴 高 | Zod 校验过于严格导致合法请求被拒 | 1. 先从宽松规则开始<br>2. 观察日志调整<br>3. 提供迁移指南     |
| 编译错误激增   | 🟡 中 | any 清理导致大量编译错误         | 1. 分阶段清理<br>2. 使用 @ts-expect-error 标记<br>3. 逐步修复 |
| 运行时行为改变 | 🟡 中 | 类型守卫逻辑与原有行为不一致     | 1. 完整测试覆盖<br>2. 对比原有行为<br>3. 灰度发布             |
| 性能影响       | 🟢 低 | Zod 校验引入 CPU 开销            | 1. 基准测试<br>2. 缓存编译后的 schema<br>3. 选择性校验        |

---

## 回滚方案

1. **类型约束回滚**: 放宽 Zod schema 规则
2. **错误格式回滚**: 保留旧错误格式兼容层
3. **any 使用**: 必要时可恢复关键路径的 any

---

## 成功指标

| 指标             | 目标值           | 测量方式                                     |
| ---------------- | ---------------- | -------------------------------------------- |
| any 使用率       | < 5%             | `grep -r "as any" --include="*.ts" \| wc -l` |
| 类型覆盖率       | > 95%            | TypeScript 严格模式检查                      |
| API 错误一致性   | 100%             | 自动化测试验证响应格式                       |
| 运行时校验覆盖率 | > 80% (关键 API) | 代码审查                                     |
| 编译时间         | 无显著退化       | 对比基准                                     |

---

## 附录: any 使用统计脚本

```bash
#!/bin/bash
# 统计 any 使用情况

echo "=== any 使用统计 ==="
echo ""
echo "1. 'as any' 使用:"
grep -r "as any" server/src --include="*.ts" | grep -v test | wc -l

echo ""
echo "2. ': any' 声明:"
grep -r ": any" server/src --include="*.ts" | grep -v test | wc -l

echo ""
echo "3. '@ts-ignore' 使用:"
grep -r "@ts-ignore" server/src --include="*.ts" | wc -l

echo ""
echo "4. 按目录统计:"
for dir in server/src/*/; do
  count=$(grep -r "as any\|: any" "$dir" --include="*.ts" | grep -v test | wc -l)
  echo "  $dir: $count"
done
```
