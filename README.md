# EasyAgentTeam

Task-driven multi-agent orchestration framework with project/workflow runtimes and observable execution.

## What Is This

EasyAgentTeam is used to:

- orchestrate role agents with task dependencies and routing
- observe execution through task tree, timeline, sessions, and runtime events

Learn more: [docs/what-is-this.md](./docs/what-is-this.md)

Platform notes: [docs/platform-support.md](./docs/platform-support.md)

## Human User Guide

If your users are ordinary people and mostly rely on Agent to deploy and run the system, start here:

- [Chinese human user guide](./docs/human-user-guide.zh-CN.md)

## Run It In 5 Minutes

1. Install dependencies.

```powershell
pnpm i
```

2. Start backend + dashboard.

```powershell
pnpm dev
```

3. In another terminal, run official first-run E2E wrapper.

Note: the main product runtime is cross-platform, but the PowerShell E2E wrappers remain Windows-only for now.

```powershell
pnpm e2e:first-run
```

4. Verify observability evidence:

- task tree: `GET /api/projects/:id/task-tree`
- timeline: `GET /api/projects/:id/agent-io/timeline?limit=200`
- workspace evidence: `<workspace>/docs/e2e/<timestamp>/run_summary.md`

Detailed guide: [docs/run-in-5-minutes.md](./docs/run-in-5-minutes.md)

## Official E2E Entry

E2E scripts are a first-class product entry, not auxiliary tests:

- standard project baseline: `pnpm e2e:standard`
- discuss baseline: `pnpm e2e:discuss`
- workflow baseline: `pnpm e2e:workflow`
- template-agent 2-case baseline (workflow + project): `pnpm e2e:template-agent`
- external-agent 3dof workflow scenario: `pnpm e2e:external-agent-3dof`
- aggregate baseline suite (chain + discuss + workflow): `pnpm e2e:baseline`

Usage template for each E2E case: [E2ETest/README.md](./E2ETest/README.md)

## Standard Engineering Gate

Run smoke + core project E2E + core workflow E2E:

```powershell
pnpm gate:standard
```

Failure triage SOP: [docs/gates/standard-gate-sop.md](./docs/gates/standard-gate-sop.md)

Gate-doc index (manual regenerate): `pnpm gate:index -- --summary <run_summary.md>`

## Boundary Checks

Advisory boundary checks for storage/orchestrator seams:

```powershell
pnpm check:boundaries
pnpm check:boundaries:strict
```

## External Agent Workspace

External Agent working-directory generator and one-click importer (v1):
Round highlight: static TemplateAgent is now maintained under `agent-workspace/template-agentstatic/`; other changes in this round focus on its tests and tooling.

```powershell
Copy-Item -Recurse -Force .\agent-workspace\template-agentstatic .\tmp\TemplateAgentWorkspace
pnpm agent-workspace -- init --goal "build a gesture-recognition workflow" --base-url http://127.0.0.1:43123 --workspace .\tmp\external-agent-workspace
pnpm agent-workspace -- validate --bundle .\agent-workspace\examples\bundle.sample.json --base-url http://127.0.0.1:43123
pnpm agent-workspace -- apply --bundle .\agent-workspace\examples\bundle.sample.json --base-url http://127.0.0.1:43123 --dry-run
pnpm agent-workspace:campaign -- --manifest .\agent-workspace\campaign\scenarios.manifest.json --base-url http://127.0.0.1:43123
```

Static template directory: `agent-workspace/template-agentstatic/` (copy-ready, no dynamic AGENTS generation).

Details: [docs/agent-workspace/README.md](./docs/agent-workspace/README.md)

## Architecture / API Details

Entry page: [docs/architecture-and-api.md](./docs/architecture-and-api.md)

Deep docs:

- backend PRDs: `server/docs/`
- dashboard docs: `dashboard-v2/docs/`
- E2E baselines: `E2ETest/README.md`

## Commands

```powershell
pnpm dev
pnpm build
pnpm test
pnpm check:boundaries
pnpm check:boundaries:strict
pnpm e2e:first-run
pnpm e2e:standard
pnpm e2e:discuss
pnpm e2e:workflow
pnpm e2e:template-agent
pnpm e2e:template-agent:cleanup:dry
pnpm e2e:template-agent:cleanup
pnpm e2e:external-agent-3dof
pnpm e2e:baseline
pnpm gate:standard
pnpm gate:index -- --summary <run_summary.md>
pnpm agent-workspace -- init --goal "<goal>" --base-url <url> [--workspace <path>]
pnpm agent-workspace -- validate --bundle <bundle.json> --base-url <url>
pnpm agent-workspace -- apply --bundle <bundle.json> --base-url <url> [--dry-run]
pnpm agent-workspace -- module-check --module <module-name> --bundle <bundle.json> --base-url <url>
pnpm agent-workspace:campaign -- --manifest <manifest.json> --base-url <url>
pnpm agent-workspace:campaign:dry -- --manifest <manifest.json> --base-url <url>
```

## License

This project is source-available for non-commercial use.
