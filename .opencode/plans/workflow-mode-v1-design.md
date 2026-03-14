# 任务流模式 V1 设计（后端先行）

## 1. 背景与目标
- 现有编排能力绑定在 `project` 维度，难以复用固定流程。
- 新增“任务流模式”用于沉淀可复用的流程模板（任务结构、角色、路由）。
- 模板可在运行时实例化，实例可独立运行，也可绑定到已有项目工作区。

## 2. 范围与非目标
- V1 范围：后端 API、数据模型、运行态与调度链路。
- V1 非目标：不改造现有项目编排器主流程；不做前端完整交互页；不迁移历史 session。

## 3. 架构原则
- 项目编排器与任务流编排器并行运行，互不共享状态文件。
- 项目模式继续稳定运行，任务流模式新建独立数据域。
- 任务流实例在创建时固化运行参数（包括 workspace 绑定），运行期不漂移。

## 4. 核心模型
- `WorkflowTemplate`
  - 固定任务拓扑（父子与依赖）
  - 角色绑定（沿用既有 role/agent 注册体系）
  - 路由规则（讨论与指派）
  - 可参数化任务文案
- `WorkflowRun`
  - 模板实例，绑定一次运行上下文
  - 固化 workspace 选择、变量参数、调度配置
  - 独立 session 集与事件流

## 5. API 草案
- 模板：
  - `POST /api/workflow-templates`
  - `GET /api/workflow-templates`
  - `GET /api/workflow-templates/:template_id`
  - `PATCH /api/workflow-templates/:template_id`
  - `DELETE /api/workflow-templates/:template_id`
- 实例：
  - `POST /api/workflow-runs`（instantiate）
  - `GET /api/workflow-runs/:run_id`
  - `POST /api/workflow-runs/:run_id/start`
  - `POST /api/workflow-runs/:run_id/stop`
  - `GET /api/workflow-runs/:run_id/status`

## 6. 工作区绑定策略
- 实例化时必须确定 workspace 绑定方式：
  - 独立 workspace
  - 绑定现有项目 workspace（仅引用目录，不继承项目状态）
- 绑定参数写入 run 配置，后续仅可读不可改。

## 7. 与现有项目域关系
- 任务流可完全独立于项目运行。
- 若绑定项目 workspace，仅共享物理目录，不共享 project 的任务板/session 状态。
- 两者的运行态冲突通过“全局层级文件锁”统一治理。

## 8. 锁策略（依赖本轮基础设施）
- 锁改为全局数据域：`data/locks/global/<workspaceHash>/`
- 锁键输入保持 workspace 相对路径，后端统一解析为绝对路径。
- 层级互斥规则：
  - `file` 与同路径 `file` 冲突
  - `file` 与祖先 `dir` 冲突
  - `dir` 与其祖先/后代 `file|dir` 冲突
- `target_type=dir` 必须显式声明，默认 `file`。

## 9. 风险与兜底
- 风险：目录锁滥用导致队列拥塞。
  - 兜底：系统提示强制“优先 file 锁，目录锁仅在必要时使用”。
- 风险：并发 acquire 产生父子路径穿透。
  - 兜底：同 workspace 维度串行化 acquire。
- 风险：跨域 sessionId 重名导致误释放。
  - 兜底：owner 采用 `ownerDomain + ownerDomainId + sessionId` 三元组校验。

## 10. 里程碑与验收标准
- M1：模板与实例数据模型落地（不影响项目编排器）。
- M2：任务流编排器最小可运行链路（start/stop/status）。
- M3：与全局锁联动，支持与项目模式并行写同一 workspace。
- 验收：
  - 不破坏现有项目模式测试。
  - 任务流实例可独立调度。
  - 绑定项目 workspace 时锁冲突可准确阻断。

## 11. 延后 TODO（本轮不实现）
- `write_file/edit_file` ToolCall 与锁强绑定校验（LockGuard）。
- 未持锁写入直接拒绝并返回 `LOCK_REQUIRED`。
- 增加审计事件：
  - `LOCK_GUARD_ALLOW`
  - `LOCK_GUARD_DENY`
