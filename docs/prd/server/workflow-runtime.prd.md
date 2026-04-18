# Workflow Runtime PRD（最后更新：2026-04-16）

## 状态

- 文档状态：`实装`

## 目标

Workflow Runtime 负责模板定义、运行实例、角色会话、任务运行态、编排调度和结束收敛，为模板化交付流程提供完整后端能力。

## 当前有效能力

- workflow template 的增删改查
- workflow run 的创建、启动、停止、状态查询
- runtime task tree / task runtime 查询
- run 级 sessions、messages、timeline、agent chat
- recurring loop / schedule 配置
- workflow 运行期 skill 注入与证据校验支撑

## 当前公开路径

- `/api/workflow-templates*`
- `/api/workflow-runs*`
- `/api/workflow-orchestrator/status`

## 兼容边界

- workflow runtime 是正式产品面
- step 旧接口已退役，不再作为主协议维护
