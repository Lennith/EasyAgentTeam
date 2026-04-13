# 运行时配置模块 PRD (Runtime Settings)

## 1. 模块目标

### 模块状态

- `实装`

### 模块职责

运行时配置模块负责存储和读取后端运行参数，覆盖 CLI、MiniMax 运行参数、主题与超时类配置。

**源码路径**:

- `server/src/data/runtime-settings-store.ts`
- `server/src/services/runtime-settings-service.ts`
- `server/src/routes/system-routes.ts` (`/api/settings`)

### 解决问题

- 提供统一配置持久化（`data/settings/runtime.json`）
- 让 runner 和 API 使用同一配置源

### 业务价值

- 降低手工改配置文件成本
- 支持动态调整模型运行参数

---

## 2. 功能范围

### 包含能力

- 默认配置生成与落盘
- 配置读取与 patch 更新
- API 暴露配置读取和更新（部分字段）

### 不包含能力

- 项目级配置（归 `project-store`）
- 会话级临时参数（归 runner 输入）

---

## 3. 对外行为

### 3.1 输入

#### API

- `GET /api/settings`
- `PATCH /api/settings`

#### 存储

- 文件：`data/settings/runtime.json`

### 3.2 输出

#### 目前 API 暴露字段

- `codexCliCommand`
- `minimaxApiKey`
- `minimaxApiBase`
- `minimaxModel`
- `minimaxSessionDir`
- `minimaxMcpServers`
- `minimaxMaxSteps`
- `minimaxTokenLimit`
- `updatedAt`

---

## 4. 内部逻辑

### 核心处理规则

1. 读取时做 normalize（空字符串、非法数字等兜底）。
2. 文件不存在时自动创建默认配置。
3. patch 时按字段级合并写回。
4. `/api/settings` 继续只维护 runtime settings，不负责 project/team/agent 的模型选择，但 provider/model 兼容校验必须复用同一份共享规则。
5. 项目、团队、agent 的模型写入路径必须拒绝非法 `provider_id + model` 组合：
   - `provider=codex` 只允许 Codex 模型清单或 Codex 默认白名单
   - `provider=minimax` 不允许写入 Codex 模型名
6. 非法 provider/model 组合必须返回：
   - `400 AGENT_MODEL_PROVIDER_MISMATCH`
   - `next_action` 明确要求切换到与 provider 匹配的模型，或切换 provider

### 完整存储字段（含 API 未暴露）

- `minimaxShellTimeout`
- `minimaxShellOutputIdleTimeout`
- `minimaxShellMaxRunTime`
- `minimaxShellMaxOutputSize`

> 上述字段已被 runner 使用，但当前 `/api/settings` 未完整透出。

---

## 5. 依赖关系

### 上游依赖

- `file-utils`（读写 JSON）

### 下游影响

- `minimax-runner`
- `model-manager-service`
- `/api/settings`

---

## 6. 约束条件

- `schemaVersion = "1.0"`
- 默认 MiniMax 模型：`MiniMax-M2.5`
- 默认 token limit：`80000`
- 不允许通过隐式 fallback 或读时静默迁移来掩盖非法 provider/model 组合。

---

## 7. 异常与边界

| 场景           | 处理                   |
| -------------- | ---------------------- |
| 配置文件不存在 | 自动创建默认文件       |
| 配置字段非法   | normalize 后回退默认值 |
| patch 字段缺失 | 保留原值               |

---

## 8. 数据定义

### 关键类型

- `RuntimeSettings`
- `MCPServerConfig`
- `PatchRuntimeSettingsInput`

---

## 9. 待确认问题

- 是否将 shell timeout 系列字段纳入 `/api/settings` 公共 API。
- 是否增加配置变更审计事件。
