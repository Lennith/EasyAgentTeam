# server/src/services

Business logic services layer. 22 service files.

## OVERVIEW

Orchestration and coordination services for the agent runtime.

## FILES

| Service | Purpose |
|---------|---------|
| `orchestrator-service.ts` | Main task dispatch, session management (2317 lines) |
| `minimax-runner.ts` | MiniMax LLM runner |
| `codex-runner.ts` | Codex execution runner |
| `task-action-service.ts` | Task action handlers |
| `manager-routing-service.ts` | Message routing |
| `task-tree-query-service.ts` | Task tree queries |
| `task-detail-query-service.ts` | Task detail queries |
| `agent-prompt-service.ts` | Prompt generation |
| `project-agent-script-service.ts` | Project script management |
| `agent-workspace-service.ts` | Workspace management |
| `task-progress-validation-service.ts` | Progress validation |
| `discuss-policy-service.ts` | Discussion policies |
| `discuss-merge-service.ts` | Discussion merging |
| `model-manager-service.ts` | Model management |
| `routing-guard-service.ts` | Routing guards |
| `agent-debug-service.ts` | Debug utilities |
| `task-creator-terminal-report-service.ts` | Terminal reports |
| `project-routing-snapshot-service.ts` | Routing snapshots |
| `manager-routing-event-service.ts` | Routing events |
| `manager-routing-event-emitter-service.ts` | Event emission |
| `project-template-service.ts` | Project templates |
| `agent-io-timeline-service.ts` | IO timeline |

## CONVENTIONS

- Service files: kebab-case `*-service.ts`
- All async, use `await` for data layer calls
- Import domain models from `../domain/models.js`

## ANTI-PATTERNS

- DO NOT add new services here — split `app.ts` instead
- DO NOT duplicate business logic already in domain layer
