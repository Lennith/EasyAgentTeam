# Orchestrator Shared Abstraction Plan (2026-03-29)

Updated: 2026-03-29  
Status: Current

This is the current canonical plan for project/workflow orchestrator convergence on the V3 hard-cut branch.

## Current State

- Shared skeletons are active in `server/src/services/orchestrator/shared/`:
  - `dispatch-template.ts`
  - `launch-template.ts`
  - `runner-template.ts`
  - `message-routing-template.ts`
  - `message-routing-contract.ts`
  - `role-candidates.ts`
  - `task-action-template.ts`
  - `tick-pipeline.ts`
  - `manager-message-contract.ts`
- Repository/UoW seam is active on both domains with the same contract family:
  - `resolveScope`
  - `runInUnitOfWork`
  - `runWithResolvedScope`
- Dispatch loop pipeline re-thin (latest round):
  - `project-dispatch-service.ts` reduced to facade + wiring (186 lines).
  - `workflow-dispatch-service.ts` reduced to facade + wiring (187 lines).
  - loop sequencing moved into dedicated pipeline modules:
    - `project-dispatch-loop-pipeline.ts` (200 lines)
    - `workflow-dispatch-loop-pipeline.ts` (251 lines)
  - both pipelines execute through `shared/dispatch-template.ts`.
- Workflow launch-support hard-cut:
  - deleted `workflow-dispatch-launch-support.ts`
  - moved launch result/error/max-token recovery handlers into:
    - `workflow-dispatch-provider-runner.ts` (290 lines)
- Project launch-helper hard-cut:
  - deleted `project-dispatch-launch-helper-service.ts`
  - moved helper payload/terminal-event/task-state updates into:
    - `project-dispatch-launch-support.ts`
- Project provider-branch hard-cut:
  - deleted `project-dispatch-launch-minimax.ts`
  - deleted `project-dispatch-launch-sync.ts`
  - merged provider execution branches into:
    - `project-dispatch-provider-runner.ts` (231 lines)
- Project message routing hard-cut:
  - `project-message-routing-service.ts` now uses:
    - `ProjectRepositoryBundle`
    - `runInUnitOfWork(...)`
    - `shared/message-routing-template.ts`
  - legacy `manager-routing-service.ts` removed.
  - `discuss-merge-service.ts` now routes via `routeProjectManagerMessage(...)`.
  - `task-creator-terminal-report-service.ts` now delivers via `deliverProjectMessage(...)`.
- Flaky mitigation hardening:
  - added shared dispatch selection support:
    - `shared/dispatch-selection-support.ts`
    - `evaluateOrchestratorDispatchSessionAvailability(...)`
    - `guardOrchestratorDuplicateTaskDispatch(...)`
  - project/workflow selection modules now consume the same session gate + duplicate-dispatch guard helper.
  - added shared message route-event append helper:
    - `shared/message-routing-events.ts`
    - project/workflow both append `USER_MESSAGE_RECEIVED -> MESSAGE_ROUTED` through shared helper.
  - added shared routed-message contract helper:
    - `shared/message-routing-contract.ts`
    - project/workflow routed manager message builders now share one contract path.
  - added shared role candidate helper:
    - `shared/role-candidates.ts`
    - workflow dispatch selection + project/workflow reminder role scans now share one role-set contract.
  - added shared duplicate-open-dispatch skip helper:
    - `buildOrchestratorDuplicateTaskDispatchSkipResult(...)`
    - project/workflow dispatch selection now share one duplicate-skip flow (guard + skip-result shaping seam).
  - added shared dispatch selection candidate helper:
    - `shared/dispatch-selection-candidate.ts`
    - project/workflow dispatch selection now share one `messages + runnable tasks + fallback` candidate resolution path.
    - project keeps explicit `message_id` override and force/dependency guards in domain adapter.
  - added shared reminder runtime helper:
    - `shared/reminder-runtime.ts`
    - project/workflow reminder services now share one role-state transition patch + eligibility path.
    - shared helpers now own:
      - role state transition patch (`INACTIVE/IDLE/RUNNING`)
      - schedule-missing patch
      - trigger patch (reminderCount + nextReminderAt)
      - eligibility decision call-through contract
  - `workflow-task-action-service.ts` now runs `TASK_CREATE` and `TASK_REPORT` through the same shared pipeline seam.
  - `workflow-task-runtime-api.test.ts` now waits for dependency-unlock state barrier before second DONE report.
  - `workflow-task-runtime-api.test.ts` now also waits `task_b -> DONE` and uses widened terminal/finished windows (`20s`).
  - `workflow-block-propagation.test.ts` now uses terminal-state barrier + retry report loop + wider finished wait window (`45s`).
  - `workflow-completion-service.ts` now persists finalized runtime timestamp through `workflowRuns.writeRuntime(...)` before `patchRun(...)`.
  - all HTTP suites in `server/src/__tests__/**` now use `startTestHttpServer(...)`;
    no direct `createServer(...).listen(0)` remains outside helper implementation.
  - bad-port retry compatibility helper removed (hard cut):
    - deleted `server/src/__tests__/helpers/fetch-with-bad-port-retry.ts`
    - affected suites now use `globalThis.fetch` directly with `startTestHttpServer(...)`.
- Current large modules (line count snapshot):
  - `workflow-task-action-service.ts` (383)
  - `project-dispatch-selection-adapter.ts` (343)
  - `project-reminder-service.ts` (308)
  - `project-message-routing-service.ts` (299)
  - `workflow-dispatch-provider-runner.ts` (290)
  - `project-session-runtime-termination.ts` (287)
  - `workflow-reminder-service.ts` (277)
  - `workflow-dispatch-selection-adapter.ts` (264)
  - `workflow-orchestrator-composition.ts` (265)
  - `workflow-dispatch-loop-pipeline.ts` (251)

## Mergeable Modules

These are safe to keep pushing into one shared contract/template family:

- Kernel and concurrency primitives:
  - `kernel/orchestrator-kernel.ts`
  - `kernel/single-flight.ts`
- Shared lifecycle/skeleton layers:
  - dispatch loop skeleton
  - launch/runner lifecycle skeleton
  - message routing skeleton
  - task-action pipeline skeleton
  - tick pipeline skeleton
- Shared message/payload contract:
  - manager-to-agent envelope/body builder in `manager-message-contract.ts`
- Repository/UoW scope pattern:
  - scope resolve + transaction entry semantics
- Shared helpers:
  - orchestrator identifiers
  - runtime/env path helpers
  - role prompt + skill bundle resolver
  - tool session input builder

## Non-Mergeable Modules

These should remain adapter-owned in this phase:

- Project-only runtime/process behavior:
  - PID/process termination detail
  - provider resume/fallback behavior
  - taskboard/project-runtime side effects
- Workflow-only runtime/state behavior:
  - run lifecycle and runtime convergence
  - workflow task-action rules and stable-window completion behavior
- Persistence model differences:
  - project taskboard/runtime docs
  - workflow run/runtime/reminder docs
- Message routing policy differences:
  - project `dispatchMessage` policy
  - workflow `sendRunMessage` policy

## Shared Abstraction Target

Shared seam root stays:

- `server/src/services/orchestrator/shared/`

Contract family (single naming system):

- `OrchestratorRepositoryScope`
- `OrchestratorDispatchPreflightAdapter`
- `OrchestratorDispatchExecutionAdapter`
- `OrchestratorDispatchMutationAdapter`
- `OrchestratorDispatchFinalizeAdapter`
- `OrchestratorDispatchLifecycleEventAdapter`
- `OrchestratorLaunchExecutionAdapter`
- `OrchestratorRunnerExecutionAdapter`
- `OrchestratorRunnerLifecycleAdapter`
- `OrchestratorMessageRoutingAdapter`
- `OrchestratorTaskActionPipelineAdapter`
- `OrchestratorTickPipeline`

Ownership boundary:

- Shared layer owns ordering/sequencing/skeleton.
- Domain adapters own business policy and domain state transitions.
- No single monolithic orchestrator class.

## Known Issues

- Structural:
  - dispatch service facade slimming is done, but domain loop branches still exist in per-domain pipeline modules (next step is shared pipeline seam extraction).
  - workflow launch/routing helper graph is reduced, but `workflow-dispatch-provider-runner.ts` still carries both provider run flow and launch lifecycle handling.
  - project launch helper spread is reduced, but `project-dispatch-launch-support.ts` still carries both payload builders and terminal side-effect helpers.
  - project provider execution paths are now single-file, but launch lifecycle logic is still duplicated conceptually between project/workflow provider runners.
  - selection adapters are still heavy and couple policy with event-side effects.
- Observed flaky watchlist (mitigations landed and currently clean):
  - `fetch bad port`
  - `workflow-block-propagation`
  - `workflow-task-runtime-api`
  - `session-timeout-closure`
  - `workflow-api parity endpoints` (`defaults/settings/task-tree/detail`) transient `404` in one full-suite pass; single-file rerun and next full pass were green.
- Latest mitigation landed:
  - `session-timeout-closure` accepts `RUNNER_TIMEOUT_SOFT` or `RUNNER_TIMEOUT_ESCALATED` to avoid env-threshold race.
  - `fetch bad port` retry shim was retired; tests now rely on deterministic `startTestHttpServer(...)` + direct `fetch`.
  - workflow runtime propagation tests now use state barriers instead of fixed timing assumptions.
  - `project/workflow` HTTP suites that used bad-port wrapper now run on direct `globalThis.fetch`.
  - route/message/settings/project/task-tree/team-summary HTTP suites migrated to `startTestHttpServer(...)`.
  - `workflow-block-propagation` finished gate timeout widened to absorb full-suite scheduler pressure.
  - `workflow-task-runtime-api` now has explicit `task_b -> DONE` barrier before terminal convergence assert.
  - latest full regression on 2026-03-29:
    - `pnpm --filter @autodev/server build` passed
    - `pnpm --filter @autodev/server test` passed
    - post-change full `server test` consecutive pass count: 3
  - latest convergence round (2026-03-29 evening):
    - `pnpm --filter @autodev/server build` passed
    - `pnpm --filter @autodev/server test` first run had one transient failure in `workflow-api` parity endpoint test (404 vs expected 200)
    - isolated rerun `node --import tsx --test --test-concurrency=1 src/__tests__/workflow-api.test.ts` passed
    - second full run `pnpm --filter @autodev/server test` passed
- Docs hygiene:
  - `tech_debt_02_orchestrator_merge.md` remains archived and must not be used as implementation source.

## Remaining Work

Round-based closeout target (3 rounds max):

1. Round A: dispatch service re-thin is complete.
   - service layer is now facade + wiring.
   - dispatch loop sequencing is isolated in domain pipeline modules.
2. Round B: routing + task-action domain parity (next).
   - keep one routing skeleton and one task-action skeleton path.
   - completed in latest round:
     - project/workflow route-event pair append path is shared.
     - project/workflow routed manager message builder path is shared.
     - workflow `TASK_CREATE/TASK_REPORT` use one task-action pipeline seam.
   - continue removing duplicated event/payload/write glue from remaining dispatch/task-action branches.
3. Round C: hard delete + stability gate.
   - remove superseded internal seams.
   - run `pnpm --filter @autodev/server build`
   - run `pnpm --filter @autodev/server test` three consecutive passes.
   - run flaky-target suites three consecutive passes.

Exit criteria for this plan:

- shared skeleton ownership is stable,
- project/workflow adapters are policy-focused,
- no duplicated orchestrator sequencing paths remain,
- flaky watchlist is empty.
