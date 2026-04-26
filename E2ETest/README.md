# E2E 场景说明（最后更新：2026-04-25）

文档状态：`验证中`

本目录只描述当前有效的场景脚本、官方 baseline 口径，以及辅助验证入口。

## 官方 Baseline

正式 baseline 只包含 3 个主场景：

- `E2ETest/scripts/run-standard-e2e.ps1`
- `E2ETest/scripts/run-discuss-e2e.ps1`
- `E2ETest/scripts/run-workflow-e2e.ps1`
- 聚合入口：`E2ETest/scripts/run-multi-e2e.ps1`

当前 baseline 默认使用 mixed-provider `agent_model_matrix`：

- 每个主场景都同时覆盖 `codex` 与 `minimax`
- `codex` 默认模型：`gpt-5.4` + `medium`
- `minimax` 默认模型：`MiniMax-M2.7-High-speed` + `high`
- `-ProviderId codex|minimax` 只作为诊断强制覆盖，不是正式 baseline 口径

## Auxiliary / Template 场景

以下脚本保留为辅助或模板验证入口，不属于正式 release baseline：

- `E2ETest/scripts/run-template-agent-e2e.ps1`
- `E2ETest/scripts/run-external-agent-3dof-e2e.ps1`
- `E2ETest/scripts/run-workflow-loop-30-validation.ps1`

## 设计边界

- reminder、redispatch、repair、timeout recovery 等机制必须在主场景内验证。
- 不新增 reminder-only、skill-import-only 之类 mechanism-only E2E。
- release gate 的正式上线检测规则以仓库根 `AGENTS.md` 为准。
- 本文档只说明脚本用途、场景覆盖和预期产物，不承担正式 release gate 规则定义。

## Provider / Model 隔离边界

- baseline 脚本优先通过 scenario `agent_model_matrix`、agent 默认模型和 project/workflow role 配置来控制 provider/model。
- `codex` 路径不依赖全局 `/api/settings` 模型项。
- mixed baseline 不再为了模型选择 patch 全局 `minimaxModel`。
- `run-standard-e2e.ps1`、`run-discuss-e2e.ps1` 和 `run-workflow-e2e.ps1` 必须通过 scenario `agent_model_matrix`、agent 默认模型和 project/workflow role 配置控制 provider/model。
- 只有显式传入 `-MiniMaxApiKeyOverride`、`-MiniMaxApiBaseOverride` 或 `-ClearMiniMaxSettings` 时，E2E settings isolation 才允许 patch MiniMax 凭证/base。
- 三个主脚本都会在 artifact 目录输出 `settings_isolation_audit.json`，记录 apply/restore 边界。

## 主场景覆盖

- `standard`：project 依赖链、任务派发、收敛闭环
- `discuss`：多角色讨论流与收敛
- `workflow`：template -> run -> sessions -> dispatch -> convergence，以及 skill 生效证据
- `multi`：聚合 `standard + discuss + workflow`
- `template-agent`：辅助静态模板工作区校验，不计入正式 baseline

## 常用命令

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-standard-e2e.ps1
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-discuss-e2e.ps1
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-workflow-e2e.ps1
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-multi-e2e.ps1
```

单 provider 诊断覆盖：

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-multi-e2e.ps1 -ProviderId codex
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-multi-e2e.ps1 -ProviderId minimax
```

## 默认 Scenario

- `E2ETest/scenarios/a-self-decompose-chain.json`
- `E2ETest/scenarios/team-discuss-framework.json`
- `E2ETest/scenarios/workflow-gesture-real-agent.json`
- `E2ETest/scenarios/workflow-external-agent-3dof.json`
- `E2ETest/scenarios/template-agent-two-case.json`

## 主场景公共产物

- `run_summary.md`
- `events.ndjson` 或 `workflow_events.jsonl`
- `task_tree_final.json` 或 `workflow_task_tree_runtime.json`
- `sessions_final.json` 或 `workflow_sessions.json`
- `reminder_probe.json` 或 `workflow_reminder_probe.json`
- `settings_isolation_audit.json`
- `provider_matrix_resolved.json`
- `provider_session_audit.json`
- `provider_activity_summary.json`

## Workflow 额外产物

- `workflow_skill_import.json`
- `workflow_skill_validation.json`
- `workflow_artifact_validation.json`
- `workflow_phase_validation.json`
- `workflow_process_validation.json`
- `workflow_subtask_dependency_validation.json`
- `workflow_code_output_validation.json`
- `workflow_agent_subtask_stats.json`
- `workflow_perf_trace.jsonl`
- `workflow_perf_summary.json`
- `workflow_perf_report.md`

## Template / Auxiliary 产物

- `template_agent_e2e_results.json`
- `template_agent_e2e_results.md`
- `workflow.result.json`
- `project.result.json`

## 正式 mixed baseline 的通过观察点

- `workflow` 需要 `artifact_validation_pass=True`
- `workflow` 需要 `subtask_stats_overall_pass=True`
- `workflow` 需要 `skill_probe_pass=True`
- `workflow` 需要 `provider_session_audit_pass=True`
- `workflow` 需要 `provider_activity_pass=True`

## Cleanup Script

```powershell
node .\E2ETest\scripts\cleanup-template-agent-test-data.mjs
node .\E2ETest\scripts\cleanup-template-agent-test-data.mjs --confirm
```

- 默认是 dry-run
- cleanup scope 只清理 allowlist 路径和测试前缀数据
