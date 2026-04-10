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

3. In another terminal, run official first-run E2E wrapper.

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
- aggregate baseline suite (chain + discuss + workflow): `pnpm e2e:baseline`

Usage template for each E2E case: [E2ETest/README.md](./E2ETest/README.md)

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
pnpm e2e:first-run
pnpm e2e:standard
pnpm e2e:discuss
pnpm e2e:workflow
pnpm e2e:baseline
pnpm gate:standard
```

## License

This project is source-available for non-commercial use.
