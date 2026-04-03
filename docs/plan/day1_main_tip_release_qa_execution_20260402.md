# Day1 Main-Tip Release QA Execution Note (2026-04-02)

## Objective

Generate a head-level release QA report for `main` tip, with full release-gate evidence and explicit waiver handling when external provider instability is the only blocker.

## Execution Sequence (must keep order)

1. `pnpm test`
2. README runnability checks: `pnpm i`, `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm e2e:first-run`
3. Run `pnpm e2e:baseline` in detached independent process
4. Manual result check only after step 3 exits

## Report Rules

- Same-day report file: `docs/release_qa_report_YYYYMMDD.md`
- Append multiple same-day runs in time order.
- If strict full gate fails only due external provider instability, add waiver record and mark decision as `PASS by waiver`.
- If failure is internal orchestrator/business logic, do not mark waiver pass.

## Evidence Checklist

- Branch + commit
- Step1/Step2/Step3/Step4 result lines
- Baseline logs and artifacts paths
- Blocker conclusion
- Waiver statement (when applied)
