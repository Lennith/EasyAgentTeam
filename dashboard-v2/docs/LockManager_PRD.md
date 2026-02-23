# 锁管理模块 PRD

## 1. 模块目标

### 模块职责

提供项目内文件/记录的锁管理能力，用于协调多个 Agent 之间的并发访问，确保文件系统的资源被合理分配，防止并发编辑导致的数据不一致。

### 解决问题

- 解决多个 Agent 同时编辑同一文件时的冲突问题
- 解决长时间占用文件导致的资源僵化问题
- 解决锁状态不透明导致的人工排查困难

### 业务价值

- 确保团队协作场景下文件访问的有序性
- 通过超时自动释放机制提高资源利用率
- 提供可视化界面用于监控和预警

---

## 2. 功能范围

### 包含能力

- **锁获取（Acquire）**：Agent 在编辑文件前主动请求锁，支持文件或目录级别
- **锁续期（Renew）**：延长持有锁的 TTL 时间
- **锁释放（Release）**：手动释放持有的锁，支持超时自动释放
- **锁查询**：列出项目内所有的锁记录及其状态
- **锁过滤**：按状态（active/released/expired）筛选锁记录
- **锁清理**：根据 lockKey 或 sessionId 批量清理

### 不包含能力

- 分布式锁的跨项目协调
- 乐观锁的版本对比机制
- 锁的强制剥夺/抢占（steal）功能

---

## 3. 对外行为

### 3.1 输入

#### 来源

- Agent 执行任务时自动获取
- 用户通过 Dashboard 手动操作
- TeamTools 集成相关

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| session_id | string | 是 | 持有锁的会话ID |
| lock_key | string | 是 | 锁定的资源路径，如 `src/app/service.ts` |
| target_type | string | 是 | 目标类型：`file` 或 `dir` |
| ttl_seconds | number | 否 | 锁存活时间（默认1800秒，即30分钟） |
| purpose | string | 否 | 锁定目的说明 |

#### 约束

- lock_key 必须是项目内的有效路径
- 同一 session_id 对同一 lock_key 只能产生一把锁
- ttl_seconds 最大值不超过 86400（24小时）

### 3.2 输出

#### 结果

- 锁获取成功：返回 `{ result: "ok" }` 并记录
- 锁获取失败：返回错误信息（已被占用）
- 锁释放成功：返回 `{ result: "ok" }`
- 查询成功：返回锁记录列表 LockRecord[]

#### 触发时机

- Agent 执行文件编辑操作前自动请求锁
- 锁即将到期时 Agent 可续期
- 用户通过 LockManagerView 查看并手动释放
- 超过 TTL 期限后系统自动将状态设为 expired

---

## 4. 内部逻辑

### 核心处理规则

#### 锁获取（Acquire）

1. 验证 session_id 和 lock_key 有效性
2. 检查 lock_key 是否已被其他 session 持有（状态为 active）
3. 若被占用，返回冲突错误
4. 若未占用，创建锁记录，状态设为 active
5. 设置 TTL 过期时间

#### 锁续期（Renew）

1. 验证 session_id 和 lock_key
2. 验证锁是否属于该会话
3. 重置 TTL 过期时间
4. increment renewCount

#### 锁释放（Release）

1. 验证 session_id 和 lock_key
2. 验证锁是否属于该会话
3. 更新状态为 released
4. 记录释放时间

#### 自动过期

- 定时检查 active 状态的锁的 expiresAt
- 已过期的锁状态更新为 expired

### 状态变化

```
(null) --acquire--> active --release--> released
 |
 +--expired--> expired (超时自动)
 +--renew--> active (续期)
```

---

## 5. 依赖关系

### 上游依赖

- **ProjectService**：提供项目信息和权限验证
- **SessionManager**：验证 session_id 有效性
- **TaskDispatcher**：协调 Agent 任务与锁的关系

### 下游影响

- **FileEditor**：依赖锁确保文件编辑安全
- **LockManagerView**：前端展示锁列表和操作界面
- **TeamTools**：提供锁管理的集成能力

---

## 6. 约束条件

### 技术约束

- 锁存储在内存数据库中
- 锁使用项目内路径，支持跨平台路径规范
- 前端通过 RESTful API 访问

### 性能要求

- 锁获取操作响应时间 < 100ms
- 锁列表查询支持分页，默认50条
- 自动过期检查间隔 <= 60秒

---

## 7. 异常处理

### 异常类型

| 异常 | 返回状态码 |
|------|----------|
| 锁已被占用 | 返回 409 Conflict，表示当前资源被占用 |
| session 无效 | 返回 400 Bad Request |
| lock_key 不在项目范围内 | 返回 400 Bad Request |
| TTL 超过最大值 | 返回 400 Bad Request |
| 释放非本会话的锁 | 返回 403 Forbidden |
| 续期非本会话的锁 | 返回 403 Forbidden |

### 边界处理

- 持有锁的会话强制终止：通过 TTL 机制自动释放
- 异常断开的会话未主动释放：依赖 TTL 机制自动释放
- 并发请求同一锁：仅有第一个请求成功，其余返回失败

---

## 8. 数据定义

### 关键数据（LockRecord）

| 字段 | 类型 | 说明 |
|------|------|------|
| lockId | string | 锁唯一标识 |
| lockKey | string | 锁定的资源路径 |
| ownerSessionId | string | 持有锁的会话ID |
| targetType | string | 目标类型：`file` \| `dir` \| `unknown` |
| purpose | string | 锁定目的说明 |
| ttlSeconds | number | TTL 设置 |
| renewCount | number | 续期次数 |
| acquiredAt | string | 获取时间（ISO8601） |
| expiresAt | string | 过期时间（ISO8601） |
| status | string | 状态：`active` \| `released` \| `expired` |
| stealReason | string | 抢占原因（TODO：待确认） |
| stolenFromSessionId | string | 被抢占的会话ID（TODO：待确认） |

### 生命周期

1. **创建**：acquire API 调用时创建记录
2. **活跃**：status = active，可被查询返回
3. **释放**：release API 调用后状态为 released
4. **过期**：TTL 过期后系统将状态设为 expired
5. **归档**：TODO（待确认：是否需要保留历史记录）

---

## 9. 待确认问题

TODO 列表：

- [ ] 自动过期机制：清理时是否同时删除记录还是仅标记过期（一时之选）
- [ ] 锁抢占功能：是否支持强制剥夺（steal），被抢占的会话如何处理
- [ ] 锁名称规范：会话超时后产生的锁是否可以继承
- [ ] 文件冲突告警：当异常发生率较高时是否需要告警
- [ ] 会话转移：是否支持将锁从一会话转移给另一会话
