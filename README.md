# EasyAgentTeam

Task-driven multi-agent orchestration framework with project/workflow runtimes and observable execution.

## What Is This

EasyAgentTeam is used to:

- orchestrate role agents with task dependencies and routing
- observe execution through task tree, timeline, sessions, and runtime events

Learn more: [docs/what-is-this.md](./docs/what-is-this.md)

## Run It In 5 Minutes

1. Install dependencies.

```powershell
pnpm i
```

2. Start backend + dashboard.

```powershell
pnpm dev
```

3. In another terminal, run first-run demo.

```powershell
pnpm demo:first-run
```

4. Verify observability evidence:

- task tree: `GET /api/projects/demo_project_mode_v1/task-tree`
- timeline: `GET /api/projects/demo_project_mode_v1/agent-io/timeline?limit=200`
- workspace evidence: `<workspace>/docs/demo/project/run_summary.md`

Detailed guide: [docs/run-in-5-minutes.md](./docs/run-in-5-minutes.md)

## Official Demos

- Project demo: `pnpm demo:project`
- Workflow demo: `pnpm demo:workflow`

Details and evidence contract: [docs/demos/README.md](./docs/demos/README.md)

## Standard Engineering Gate

Run smoke + core project E2E + core workflow E2E:

```powershell
pnpm gate:standard
```

Failure triage SOP: [docs/gates/standard-gate-sop.md](./docs/gates/standard-gate-sop.md)

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
pnpm demo:first-run
pnpm demo:project
pnpm demo:workflow
pnpm gate:standard
```

## License

This project is source-available for non-commercial use.
