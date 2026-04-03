# Release Tail Retrospective (2026-04-02, 30min)

## Q1. 本轮 merge 后，主线最稳定的边界是哪几条

- Task protocol 主入口稳定在 `POST /api/projects/:id/task-actions` 与对应 workflow task-actions。
- Orchestrator shared skeleton 是唯一主路径，project/workflow 差异稳定在 adapter/policy。
- Storage 主链路事务边界稳定在 repository bundle + UnitOfWork seam。

## Q2. 哪些地方是“代码已收口、文档未追平”

- `docs/architecture-and-api.md` 之前只做索引，未承接 runtime/storage/gate 导航（本轮已补齐主导航）。
- gate 产物与 QA 报告的自动回链之前缺失（本轮新增 gate-doc index 输出）。
- storage/orchestrator 边界虽然在 PRD 有规则，但之前缺可执行检查入口（本轮补充轻量检查命令）。

## Q3. 下轮方向：继续收 storage，还是转新功能

- 结论：先继续收 storage 命名与边界一致性，再切新功能。
- 理由：storage PRD 仍是 `改动中`，且术语与职责边界仍有技术债条目，先收口更利于后续迭代稳定性。

## Hard Constraints (Next Round)

- 下轮不再新增 orchestrator shared 的 compat/helper/contract 命名体系。
- 下轮新功能改动若涉及主链路写入，必须通过 repository bundle，不允许 route/service 直连 store/storage。
- 下轮开始前先对照 `tech_debt_07_release_tail_closure_20260402.md` 更新 owner 与退出条件，避免 debt 回流主 PRD。
