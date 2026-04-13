# PRD: Agent and Skill Registry

## 1. Scope

This document defines the backend behavior for:

- global agent registry
- imported skill registry
- reusable skill lists
- provider runtime skill resolution for project and workflow runtime
- team document consumption of agent summaries

This module is the backend source of truth for reusable agent metadata and imported local skills.

## 2. Product Goals

### 2.1 Agent Registry

The registry provides reusable agent definitions that can be attached to projects, teams, and workflows.

Each agent definition stores:

- `agentId`
- `displayName`
- `prompt`
- `summary`
- `skillList`
- optional `defaultCliTool`

### 2.2 Skill Registry

The skill registry provides a managed library of imported local skill packages.

Goals:

- import skill packages from local paths
- normalize the package contract to a standard `SKILL.md`
- preserve sibling files and nested directories as package dependencies
- expose normalized metadata for UI and runtime injection

### 2.3 Skill Lists

Skill lists provide reusable skill groups referenced by agent definitions.

Goals:

- allow multiple named lists
- support `includeAll` dynamic full-library inclusion
- allow explicit skill selection on top of dynamic inclusion
- resolve ordered, deduplicated skill ids at runtime

## 3. Public API

### 3.1 Agent API

- `GET /api/agents`
- `POST /api/agents`
- `PATCH /api/agents/:agent_id`
- `DELETE /api/agents/:agent_id`

Agent input fields:

- `agent_id`
- `display_name`
- `prompt`
- `summary`
- `skill_list`
- `provider_id`

Validation rules:

- `agent_id` is required on create
- `display_name` is required on create
- `prompt` is required on create
- `skill_list` must reference existing skill list ids
- deleting an agent removes only the registry record, not project or workflow runtime data

### 3.2 Skill API

- `GET /api/skills`
- `POST /api/skills/import`
- `DELETE /api/skills/:skill_id`

Import request shape:

```json
{
  "sources": ["C:\\Users\\spiri\\.config\\opencode\\skills\\minimax-vision"],
  "recursive": true
}
```

Import response shape:

```json
{
  "imported": [
    {
      "skill": {
        "skillId": "minimax-vision",
        "name": "minimax-vision",
        "description": "Imported skill",
        "license": "UNSPECIFIED",
        "compatibility": "opencode"
      },
      "action": "created",
      "warnings": []
    }
  ],
  "warnings": []
}
```

### 3.3 Skill List API

- `GET /api/skill-lists`
- `POST /api/skill-lists`
- `PATCH /api/skill-lists/:list_id`
- `DELETE /api/skill-lists/:list_id`

Validation rules:

- `list_id` must match `[a-zA-Z0-9._:-]+`
- explicit `skill_ids` must exist in the skill registry
- deleting a skill list is rejected if any registered agent still references it

## 4. Skill Import Contract

### 4.1 Accepted Source Shapes

The import entry accepts:

- a directory path
- a direct `SKILL.md` path

Recursive behavior:

- if the source is a directory and `recursive=true`, the importer recursively discovers every `SKILL.md`
- each discovered `SKILL.md` defines one skill package root at its parent directory

Important package rule:

- the required file is only `SKILL.md`
- all other files or folders under the same package root are treated as package dependencies and copied into the managed package

### 4.2 Source Detection

Current source detection rules:

- path containing `/.config/opencode/skills/` -> `sourceType=opencode`
- path containing `/.codex/skills/` -> `sourceType=codex`
- all other sources -> `sourceType=local`

### 4.3 Standardized Output

Every imported package is rewritten to the standard contract:

```md
---
name: <name>
description: <description>
license: <license>
compatibility: <compatibility>
---

<body>
```

Required frontmatter fields:

- `name`
- `description`
- `license`
- `compatibility`

Fallback rules:

- missing `name` -> folder name
- missing `description` -> first non-heading body paragraph
- missing `license` -> `UNSPECIFIED`
- missing `compatibility` -> inferred from source type

Every fallback produces a warning.

### 4.4 Conflict Behavior

`skillId` is normalized from the final skill name.

Conflict rule:

- importing the same `skillId` overwrites the managed package and updates the registry entry

## 5. Persistence Layout

Registry storage:

- `data/skills/registry.json`
- `data/skills/lists.json`

Managed packages:

- `data/skills/packages/<skill_id>/...`

Agent registry storage:

- `data/agents/registry.json`

## 6. Runtime Resolution

### 6.1 Skill List Resolution

At runtime, `resolveSkillIdsForAgent()` resolves agent `skillList` ids into final skill ids.

Resolution algorithm:

1. iterate agent `skillList` in order
2. if a list has `includeAll=true`, append all imported skill ids in registry order
3. append that list's explicit `skillIds`
4. deduplicate while preserving first occurrence order

### 6.2 Prompt Segment Resolution

`resolveImportedSkillPromptSegments()` loads each managed package `SKILL.md` and produces prompt segments.

Each resolved segment includes:

- skill header
- description
- normalized body content

Missing registry entries or missing entry files produce warnings and are skipped.

### 6.3 Injection Boundary

Imported local skills are injected on provider runtime execution paths for both MiniMax and Codex.

Current TeamTool injection points:

- project orchestrator dispatch via provider runtime / runner launch
- project agent chat via provider runtime + TeamTool injection
- workflow orchestrator dispatch via provider runtime + TeamTool injection
- workflow agent chat via provider runtime + TeamTool injection

Current non-injected paths:

- any external execution path that does not use the provider runtime TeamTool injection path
- Codex native/global skills remain owned by Codex CLI / `CODEX_HOME` and are not managed by this registry injection path

## 7. Team Document Consumption

`summary` is consumed by workspace bootstrap in `server/src/services/agent-workspace-service.ts`.

Generated `Agents/TEAM.md` member entries use:

- link to the agent workspace directory
- optional summary text from the agent registry

The project or workflow workspace does not own the `summary` value and does not write it back to agent registry storage.

## 8. Constraints and Error Cases

### 8.1 Skill Import Errors

- invalid source path
- missing `SKILL.md`
- unsupported file path that is not a directory or `SKILL.md`

### 8.2 Skill List Errors

- invalid list id
- duplicate list id
- explicit reference to unknown skill id
- delete request for a list still referenced by an agent

### 8.3 Agent Registry Errors

- invalid or missing required agent fields
- unknown skill list references on create or patch

## 9. Current Status

Status: `改动中`
