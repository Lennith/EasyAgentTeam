# Standard Gate SOP

Standard gate combines:

1. smoke check
2. project core E2E
3. workflow core E2E

## Run

```powershell
pnpm gate:standard
```

## Success Criteria

- command exits with code `0`
- summary file exists at:
  - `.e2e-workspace/standard-gate/<timestamp>/run_summary.md`
- all three steps are `success: true`

## Failure Triage (Shortest Path)

1. Open gate summary first:

```text
.e2e-workspace/standard-gate/<timestamp>/run_summary.md
```

2. Locate failed step log:

- `01_smoke.log`
- `02_project_core_e2e.log`
- `03_workflow_core_e2e.log`

3. If E2E failed, open the step artifact directory printed as `artifacts=...` in step log.

4. Fix and rerun only failed step first:

```powershell
# smoke
pnpm test:smoke

# project core E2E
pnpm e2e:standard

# workflow core E2E
pnpm e2e:workflow
```

5. After single-step pass, rerun full gate:

```powershell
pnpm gate:standard
```
