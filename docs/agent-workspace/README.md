# Agent Workspace v1

`agent-workspace` is the external Agent working-directory generator and one-click importer for EasyAgentTeam.

Static copy-ready workspace:

- `TemplateAgentWorkspace/`
- Can be copied directly for out-of-box TemplateAgent usage.

## Command Entry

- `node agent-workspace/cli.mjs init --goal "<goal>" --base-url <url> [--workspace <path>]`
- `node agent-workspace/cli.mjs validate --bundle <path> --base-url <url>`
- `node agent-workspace/cli.mjs apply --bundle <path> --base-url <url> [--dry-run]`
- `node .agent-tools/scripts/template_bundle_guard.mjs check|publish` (inside initialized workspace)

Root helper scripts:

- `pnpm agent-workspace -- init --goal "<goal>" --base-url <url> [--workspace <path>]`
- `pnpm agent-workspace -- validate --bundle <path> --base-url <url>`
- `pnpm agent-workspace -- apply --bundle <path> --base-url <url> [--dry-run]`
- `pnpm agent-workspace:campaign -- --manifest <path> --base-url <url>`
- `pnpm agent-workspace:campaign:dry -- --manifest <path> --base-url <url>`
- `node agent-workspace/campaign/observe-real-round.mjs --base-url <url> --run-id <run> --round <n> --scenario-id <id> --round-dir <path> --import-report-json <path> --runtime-actions-json <path>`

`init` behavior (current): copy static template `TemplateAgentWorkspace/` into target workspace, then patch `.agent-tools/config.json` `base_url`.

Campaign agent mode policy:

- `agent-workspace:campaign` supports `--agent-mode simulated|internal` only.
- Real external-agent verification is executed manually with a single TemplateAgent (no campaign real-script mode).
- Template feature tests may use simulated mode only when validating framework code changes.
- Real acceptance/regression must use a real TemplateAgent; if no external agent is specified, use one subagent as TemplateAgent.

Internal debug command:

- `pnpm agent-workspace -- module-check --module skill.bundle.validate --bundle <path> --base-url <url>`

## Behavior Defaults

- single bundle per run
- conflict policy: fail on name/id conflict (no upsert)
- full-chain apply order: skills -> skill_lists -> agents -> project -> workflow_template -> workflow_run
- workflow run is created with `auto_start=false`
- rollback is reverse-order and only for resources created in current apply
- project mode requires dedicated QA Guard agent (id suffix `_qa_guard`) in routing and acceptance ownership

## AGENTS.md Contract Highlights

Generated `AGENTS.md` enforces:

- goal-optimized but reusable role design
- fixed workspace directories: `workspace/`, `roles/`, `agents/`, `bundles/`, `reports/`
- submit path only through local skill entry `template_bundle_guard`
- mandatory 6-step flow with per-step check output under `reports/step-XX-*.md|json`

## TemplateAgent Submit Reports

- `<workspace>/reports/template-guard/last_check.json|md`
- `<workspace>/reports/template-guard/last_publish.json|md`
- report fields include `status`, `errors`, `hints`, `bundle_id`, `project_id`, `template_id`, `run_id`, `timestamp`

Supervisor default behavior:

- `run-two-rounds-real` reads `last_publish.json` as submission source.
- `--controller-apply` is fallback debug path only.

## Contract and Sample

- Contract: `docs/contracts/agent-workspace-bundle.contract.json`
- Sample bundle: `agent-workspace/examples/bundle.sample.json`

## Campaign Runner

- Default manifest: `agent-workspace/campaign/scenarios.manifest.json` (2 project + 10 workflow)
- Base constraint pack: `agent-workspace/campaign/constraint-pack.md`
- Output: `agent-workspace/reports/campaign/<run-id>/campaign_report.json|md`
- Contracts:
  - `docs/contracts/agent-workspace-campaign-manifest.contract.json`
  - `docs/contracts/agent-workspace-campaign-report.contract.json`
