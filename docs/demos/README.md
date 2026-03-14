# Official Demos

This repository ships two official demos:

- `project mode demo`
- `workflow mode demo`

Both demos follow the same delivery contract:

- Template file under `docs/demos/templates/`
- Import + execute script under `tools/demo/`
- Expected evidence written into the demo workspace under `docs/demo/`

Runtime snapshots under repository `data/**` are not part of demo assets.

## Project Mode Demo

Template:

- `docs/demos/templates/project-mode-demo.json`

Run:

```powershell
pnpm demo:project
```

Success evidence:

- task tree includes `demo_project_root` with `DONE`
- events include `ORCHESTRATOR_DISPATCH_STARTED`
- events include `TASK_REPORT_APPLIED`
- workspace has `docs/demo/project/run_summary.md`

## Workflow Mode Demo

Template:

- `docs/demos/templates/workflow-mode-demo.json`

Run:

```powershell
pnpm demo:workflow
```

Success evidence:

- task runtime includes `wf_plan` and `wf_execute` with `DONE`
- workflow events include `ORCHESTRATOR_DISPATCH_STARTED`
- workflow events include `TASK_REPORT_APPLIED`
- workspace has `docs/demo/workflow/run_summary.md`
