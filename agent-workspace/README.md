# agent-workspace

External Agent workspace generator plus bundle validator/importer for EasyAgentTeam.

## Static Template Workspace

Out-of-box static TemplateAgent workspace:

- `agent-workspace/template-agentstatic/` (repo root view)
- `template-agentstatic/` (inside `agent-workspace`)

You can copy this directory directly and start using it without running `init`.

## Primary Commands

`agent-workspace` is a private workspace package named `@autodev/agent-workspace`.
Use the root package scripts as the supported product entry surface.

```powershell
pnpm agent-workspace -- init --goal "build a gesture-recognition workflow" --base-url http://127.0.0.1:43123 --workspace .\tmp\external-agent-workspace
pnpm agent-workspace -- validate --bundle .\agent-workspace\examples\bundle.sample.json --base-url http://127.0.0.1:43123
pnpm agent-workspace -- apply --bundle .\agent-workspace\examples\bundle.sample.json --base-url http://127.0.0.1:43123 --dry-run
pnpm agent-workspace:campaign -- --manifest .\agent-workspace\campaign\scenarios.workflow.manifest.json --base-url http://127.0.0.1:43123
pnpm agent-workspace:real-two-rounds -- --base-url http://127.0.0.1:43123 --data-root .\data
pnpm agent-workspace:pack
pnpm agent-workspace:verify
```

TemplateAgent default submit flow (inside initialized workspace):

```powershell
node .agent-tools\scripts\template_bundle_guard.mjs check
node .agent-tools\scripts\template_bundle_guard.mjs publish
```

Internal debug command:

```powershell
pnpm agent-workspace -- module-check --module skill.bundle.validate --bundle .\agent-workspace\examples\bundle.sample.json --base-url http://127.0.0.1:43123
```

## Init Output

`init` copies the static template workspace and patches `base_url`:

- `AGENTS.md`
- `workspace/`
- `roles/`
- `agents/`
- `bundles/template.bundle.sample.json`
- `reports/step-01-goal.* ... step-06-submit.*`
- `.agent-tools/config.json`
- `.agent-tools/scripts/template_bundle_guard.mjs`
- `.agent-tools/skills/template_bundle_guard/SKILL.md`

## Reports

Validate/apply writes:

- `agent-workspace/reports/<timestamp>-<bundle_id>/import_report.json`
- `agent-workspace/reports/<timestamp>-<bundle_id>/import_report.md`

Init writes:

- `<workspace>/reports/step-00-init.json`
- `<workspace>/reports/step-00-init.md`

Campaign writes:

- `agent-workspace/reports/campaign/<run-id>/campaign_report.json`
- `agent-workspace/reports/campaign/<run-id>/campaign_report.md`

Pack writes:

- `dist/release_artifacts/<package>.tgz`
- `dist/release_artifacts/<package>.tgz.manifest.json`

Real two-round supervisor writes:

- `agent-workspace/reports/real-two-rounds/<run-id>/round-*/round_result.json|md`
- `agent-workspace/reports/real-two-rounds/<run-id>/round-*/event_evidence.json`
- `agent-workspace/reports/real-two-rounds/<run-id>/round-*/artifact_check.json`
- `agent-workspace/reports/real-two-rounds/<run-id>/round-*/root_cause.md`
- TemplateAgent skill writes:
  - `<workspace>/reports/template-guard/last_check.json|md`
  - `<workspace>/reports/template-guard/last_publish.json|md`

`run-two-rounds-real` now reads `reports/template-guard/last_publish.json` by default.
Use `--controller-apply` only for maintainer fallback debugging.

Campaign supports `--agent-mode simulated|internal` only.
Real external-agent verification must use manual single-TemplateAgent flow (no script-driven real mode).
Simulated mode is only for framework feature tests; real acceptance/regression must use one real TemplateAgent (default to one subagent when no external agent is provided).
TemplateAgent uses local `template_bundle_guard` skill to validate and publish bundle.
Run lifecycle control and convergence observation are controller-only responsibilities.
