# Agent Management PRD

## 1. Scope

The Agent Management module is the global UI for reusable agent definitions.

It covers:

- agent registry list and editor
- agent template application during create
- provider override selection
- agent summary editing
- skill list binding

It does not cover:

- project-level session runtime
- workflow run session runtime
- direct skill library editing
- project or workflow side mutation of agent registry data

## 2. Product Goals

The module provides one place to manage reusable agent metadata before those agents are referenced by teams, projects, or workflow runs.

Current goals:

- create and update agent definitions
- attach reusable summaries for team documentation
- attach reusable skill list references for MiniMax injection
- keep agent prompt and provider override together in one form
- allow fast agent bootstrap from templates or copy-from-existing

## 3. Navigation and Views

L1 module: `Agents`

L2 views:

- `sessions`
- `agents`
- `templates`

This PRD covers `AgentRegistryView`, which is the `#/agents/agents` view.

## 4. User Capabilities

### 4.1 List Agents

The registry view lists all registered agents with:

- display name
- `agentId`
- prompt
- optional summary
- bound skill list ids
- optional provider override badge
- last updated time

### 4.2 Create Agent

Create form fields:

- `agent_id`
- `display_name`
- `prompt`
- `summary`
- `skill_list` multi-select
- `provider_id` optional override

Additional create actions:

- apply an existing agent template
- copy prompt, summary, and skill list bindings from an existing agent

### 4.3 Edit Agent

Editable fields:

- `display_name`
- `prompt`
- `summary`
- `skill_list`
- `provider_id`

### 4.4 Delete Agent

Delete removes the registry entry after confirmation.

## 5. Data Contract

Frontend model:

```ts
interface AgentDefinition {
  agentId: string;
  displayName: string;
  prompt: string;
  summary?: string;
  skillList?: string[];
  updatedAt: string;
  defaultCliTool?: "codex" | "trae" | "minimax";
}
```

Semantic rules:

- `summary` is a short role description shown in generated `Agents/TEAM.md`
- `skillList` stores skill list ids, not raw skill ids
- `defaultCliTool` is an agent-level override over project-level provider defaults

## 6. Backend Dependency

The view depends on:

- `GET /api/agents`
- `POST /api/agents`
- `PATCH /api/agents/:agent_id`
- `DELETE /api/agents/:agent_id`
- `GET /api/agent-templates`
- `GET /api/skill-lists`

Validation expectations:

- backend rejects unknown skill list references
- backend accepts `summary: null` on patch to clear the field
- backend accepts `provider_id` as the stored override field

## 7. UX Behavior

### 7.1 Loading

The page loads agents, templates, and skill lists before showing the editable registry.

### 7.2 Empty State

If no agents exist, the page shows an empty state with the create action.

### 7.3 Save State

Create and edit actions disable buttons while saving.

### 7.4 Copy From Existing Agent

Copying from an existing agent pre-fills:

- display name suffix `(Copy)`
- prompt
- summary
- skill list bindings

## 8. Cross-Module Semantics

### 8.1 Team Documents

Agent `summary` is consumed by workspace bootstrap and rendered in generated `Agents/TEAM.md` lines.

### 8.2 Skill Injection

Agent `skillList` is resolved by the backend skill registry to final skill ids.

Only MiniMax runtime paths inject imported skill segments.

### 8.3 Project and Workflow Consumption

Project and workflow views consume agent registry output but do not provide an editing path for `summary` or `skill_list`.

## 9. Non-Goals

- editing raw imported skill packages
- editing skill lists inside the agent form
- per-project or per-run overrides of `summary`
- direct session creation or repair from the agent registry view

## 10. Status

Status: `ACTIVE`
