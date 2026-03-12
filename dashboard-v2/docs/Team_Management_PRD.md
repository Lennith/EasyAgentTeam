# Team Management PRD

## 1. Scope

The Team Management module is the reusable collaboration-topology editor.

It covers:

- team list
- team create
- team edit
- member list management
- message routing
- task assignment routing
- discuss round configuration
- per-agent provider/model/effort configuration

It does not cover:

- global agent prompt editing
- skill import or skill list maintenance
- project or workflow runtime inspection

## 2. Product Goals

Teams define reusable routing and provider topology that can be consumed by projects and workflows.

Current goals:

- centralize collaboration topology in one place
- manage reusable agent membership by `agent_id`
- configure message and task routing independently
- configure provider, model, and effort for each team member

## 3. Navigation

L1 module: `Teams`

Views:

- `#/teams`
- `#/teams/new`
- `#/teams/edit/:teamId`

## 4. User Capabilities

### 4.1 Team List

The list page supports:

- viewing all teams
- opening a team editor
- deleting a team
- creating a new team

### 4.2 Team Editor

Editable team fields:

- `team_id`
- `name`
- `description`
- `agent_ids`
- `route_table`
- `task_assign_route_table`
- `route_discuss_rounds`
- `agent_model_configs`

The editor is organized into tabs:

- `members`
- `message`
- `task`

### 4.3 Member Management

The member tab supports:

- adding an agent id
- removing an agent id
- selecting provider per member
- selecting model per member
- selecting effort per member

### 4.4 Message Routing

The message routing tab supports:

- enabling or disabling routes from one agent to another
- setting discuss rounds per route

### 4.5 Task Routing

The task routing tab supports:

- enabling or disabling task assignment routes from one agent to another

## 5. Backend Dependency

The Team module depends on:

- `GET /api/teams`
- `GET /api/teams/:team_id`
- `POST /api/teams`
- `PUT /api/teams/:team_id`
- `DELETE /api/teams/:team_id`
- `GET /api/models`

## 6. Data Contract

Frontend model:

```ts
interface TeamRecord {
  teamId: string;
  name: string;
  description?: string;
  agentIds: string[];
  routeTable: Record<string, string[]>;
  taskAssignRouteTable: Record<string, string[]>;
  routeDiscussRounds: Record<string, Record<string, number>>;
  agentModelConfigs: Record<string, AgentModelConfig>;
}
```

Current provider options:

- `codex`
- `trae`
- `minimax`

## 7. Cross-Module Semantics

### 7.1 Agent Registry

Teams reference agent ids from the global agent registry but do not edit agent `prompt`, `summary`, or `skill_list`.

### 7.2 Project and Workflow Consumption

Projects and workflow templates/runs consume team routing and model settings as reusable topology.

### 7.3 Team Documents

Generated workspace `TEAM.md` files use agent registry summaries during workspace bootstrap, not team-authored summary fields.

## 8. Validation and Error Behavior

Backend validation is expected for:

- invalid or duplicate member ids
- invalid route targets
- invalid model/provider combinations

The UI handles:

- loading state
- save state
- empty-member state for routing tabs
- confirmation before delete

## 9. Non-Goals

- live runtime session control
- skill library operations
- project workspace tasks or locks

## 10. Status

Status: `ACTIVE`
