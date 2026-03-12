# Project Management PRD

## 1. Scope

The Project Management module owns project lifecycle and the project workspace UI.

It covers:

- project list
- project creation and deletion
- project workspace navigation
- task, session, timeline, lock, and routing views
- project orchestrator settings

It does not cover:

- workflow template and workflow run management
- global skill library management
- global agent registry editing

## 2. Product Goals

Project mode is the concrete delivery runtime for task-first multi-agent collaboration inside a project workspace.

Current goals:

- create isolated project workspaces
- expose the full task-first runtime surface
- let operators inspect routing, sessions, events, and task state in one place
- expose project-level control of auto dispatch, hold, and reminder behavior

## 3. Navigation

L1 module: `Projects`

Views:

- project list at `#/projects`
- new project at `#/new-project`
- project workspace at `#/project/:projectId/:view`

Project workspace tabs:

- `timeline`
- `chat`
- `session-manager`
- `agent-io`
- `agent-chat`
- `taskboard`
- `task-tree`
- `task-create`
- `task-update`
- `lock-manager`
- `team-config`
- `project-settings`

## 4. User Capabilities

### 4.1 Project List

The project list supports:

- listing all projects
- opening a project workspace
- deleting a project

### 4.2 Create Project

The create flow supports:

- `project_id`
- `name`
- `workspace_path`
- optional `template_id`
- optional `team_id`
- optional `agent_ids`
- optional auto-dispatch settings

### 4.3 Project Workspace

The project workspace provides operational views for:

- event timeline
- routed chat timeline
- session lifecycle management
- agent I/O timeline
- agent chat
- taskboard and task tree
- task create and task patch
- workspace lock management
- team and routing configuration
- project-level orchestrator settings

## 5. Backend Dependency

Primary project endpoints:

- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:id`
- `DELETE /api/projects/:id`
- `GET /api/projects/:id/task-tree`
- `GET /api/projects/:id/tasks/:task_id/detail`
- `POST /api/projects/:id/task-actions`
- `PATCH /api/projects/:id/tasks/:task_id`
- `POST /api/projects/:id/messages/send`
- `GET /api/projects/:id/sessions`
- `POST /api/projects/:id/sessions`
- `POST /api/projects/:id/sessions/:session_id/dismiss`
- `POST /api/projects/:id/sessions/:session_id/repair`
- `GET /api/projects/:id/agent-io/timeline`
- `GET /api/projects/:id/events`
- `GET/PATCH /api/projects/:id/orchestrator/settings`
- `POST /api/projects/:id/orchestrator/dispatch`
- `POST /api/projects/:id/orchestrator/dispatch-message`
- `GET/PATCH /api/projects/:id/task-assign-routing`
- `/api/projects/:id/locks/*`

Retired endpoints are not part of the product surface.

## 6. Data and Semantics

### 6.1 Project Detail

Project detail may include:

- `agentIds`
- `routeTable`
- `taskAssignRouteTable`
- `routeDiscussRounds`
- `agentModelConfigs`
- `autoDispatchEnabled`
- `autoDispatchRemaining`
- `holdEnabled`

### 6.2 Reminder and Dispatch Controls

Project settings expose:

- auto dispatch enabled flag
- remaining dispatch budget
- hold flag
- reminder mode

Reminder messages are task-aware and share the same contract as workflow reminders.

### 6.3 Workspace Documents

Generated `Agents/TEAM.md` consumes agent registry `summary` values but the project UI does not edit those global agent fields.

## 7. UX Expectations

- project list loads on module entry
- workspace tabs switch without leaving project context
- settings and routing views write directly through backend APIs
- destructive actions require confirmation

## 8. Non-Goals

- workflow-phase orchestration management
- skill package import
- agent registry maintenance

## 9. Status

Status: `ACTIVE`
