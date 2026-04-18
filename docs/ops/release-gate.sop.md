# Release Gate 辅助脚本说明（最后更新：2026-04-16）

本页只说明辅助脚本 `pnpm gate:standard` 和 gate index 的定位，不是正式上线检测规则源。

## 权威规则

- 正式上线检测流程、顺序、停止条件、PASS/FAIL 口径，以仓库根 `AGENTS.md` 为准。
- 本页只覆盖本地辅助脚本的产物结构和排障方法。

## 辅助脚本

```powershell
pnpm gate:standard
```

该脚本会生成：

- `.e2e-workspace/standard-gate/<timestamp>/run_summary.md`
- `.e2e-workspace/standard-gate/<timestamp>/gate_doc_index.json`
- `.e2e-workspace/standard-gate/<timestamp>/gate_doc_index.md`

## 最短排障路径

1. 先看 `run_summary.md`
2. 再看失败步骤日志：
   - `01_smoke.log`
   - `02_project_core_e2e.log`
   - `03_workflow_core_e2e.log`
3. 如果是 E2E 失败，再进入日志里打印的 `artifacts=...` 目录
4. 单步修复后，再回到完整 gate

## Gate Index 手工重生

```powershell
pnpm gate:index -- --summary .e2e-workspace/standard-gate/<timestamp>/run_summary.md
```
