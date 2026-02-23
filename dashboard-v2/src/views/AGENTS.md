# dashboard-v2/src/views

React view components. 23 TSX files.

## OVERVIEW

Hash-router based views for project/team/agent management.

## FILES

| View | Purpose |
|------|---------|
| `ProjectsHome.tsx` | Project list |
| `NewProjectView.tsx` | Create project |
| `ProjectWorkspace.tsx` | Project detail |
| `ProjectSettingsView.tsx` | Project settings |
| `TaskboardView.tsx` | Task board |
| `TaskTreeView.tsx` | Task tree |
| `CreateTaskView.tsx` | Create task |
| `UpdateTaskView.tsx` | Edit task |
| `AgentRegistryView.tsx` | Agent registry |
| `AgentSessionsView.tsx` | Agent sessions |
| `AgentIOView.tsx` | Agent IO timeline |
| `AgentTemplatesView.tsx` | Agent templates |
| `SessionManagerView.tsx` | Session management |
| `TeamsHome.tsx` | Teams list |
| `NewTeamView.tsx` | Create team |
| `TeamEditorView.tsx` | Edit team |
| `LockManagerView.tsx` | Lock management |
| `RoutingConfigView.tsx` | Routing config |
| `SettingsView.tsx` | App settings |
| `CodexOutputView.tsx` | Codex output |
| `EventTimelineView.tsx` | Event timeline |
| `ChatTimelineView.tsx` | Chat timeline |
| `DebugAgentSessionsView.tsx` | Debug sessions |

## CONVENTIONS

- Functional components with hooks
- Props via TypeScript interfaces
- Hash-based routing via `App.tsx`

## ANTI-PATTERNS

- DO NOT duplicate types — import from `@autodev/agent_library`
- DO NOT add new views without adding route in `App.tsx`
