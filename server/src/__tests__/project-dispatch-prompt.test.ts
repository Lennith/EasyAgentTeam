import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectRecord, SessionRecord, TaskRecord } from "../domain/models.js";
import { buildProjectDispatchPromptContext } from "../services/orchestrator/project/project-dispatch-prompt-context.js";
import { buildProjectDispatchPrompt } from "../services/orchestrator/project/project-dispatch-prompt.js";

test("project dispatch prompt keeps routing snapshot, focus task, and discuss guide contract", () => {
  const project = {
    schemaVersion: "1.0",
    projectId: "project_alpha",
    name: "Project Alpha",
    workspacePath: "D:\\AgentWorkSpace\\ProjectAlpha",
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:00:00.000Z"
  } as ProjectRecord;
  const session = {
    schemaVersion: "1.0",
    sessionId: "session_dev",
    projectId: "project_alpha",
    role: "dev",
    provider: "minimax",
    status: "idle",
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:00:00.000Z",
    lastActiveAt: "2026-03-28T10:00:00.000Z"
  } as SessionRecord;
  const task = {
    taskId: "task_focus",
    taskKind: "EXECUTION",
    parentTaskId: "root",
    rootTaskId: "root",
    title: "Implement focus task",
    ownerRole: "dev",
    state: "READY",
    writeSet: [],
    dependencies: ["task_dep"],
    acceptance: [],
    artifacts: [],
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:00:00.000Z"
  } as TaskRecord;
  const dep = {
    ...task,
    taskId: "task_dep",
    title: "Dependency task",
    ownerRole: "qa",
    state: "IN_PROGRESS",
    dependencies: []
  } as TaskRecord;
  const promptContext = buildProjectDispatchPromptContext({
    project,
    session,
    taskId: "task_focus",
    messages: [
      {
        envelope: {
          message_id: "msg-1",
          project_id: "project_alpha",
          timestamp: "2026-03-28T10:00:00.000Z",
          sender: { type: "system", role: "manager", session_id: "manager-system" },
          via: { type: "manager" },
          intent: "TASK_DISCUSS_REQUEST",
          priority: "normal",
          correlation: { request_id: "request-1", task_id: "task_focus" },
          accountability: {
            owner_role: "dev",
            report_to: { role: "manager", session_id: "manager-system" },
            expect: "DISCUSS_REPLY"
          },
          dispatch_policy: "fixed_session"
        },
        body: {
          messageType: "TASK_DISCUSS_REQUEST",
          mode: "CHAT",
          taskId: "task_focus",
          discuss: { thread_id: "thread-1", round: 1, max_rounds: 3 },
          content: "Need status"
        }
      }
    ] as any,
    routingSnapshot: {
      projectId: "project_alpha",
      fromAgent: "dev",
      fromAgentEnabled: true,
      enabledAgents: ["dev", "qa"],
      hasExplicitRouteTable: true,
      allowedTargets: [{ agentId: "qa", maxDiscussRounds: 2 }]
    },
    allTasks: [task, dep]
  });

  const prompt = buildProjectDispatchPrompt(promptContext);

  assert.match(prompt, /## Routing Snapshot/);
  assert.match(prompt, /focus_task_id: task_focus/);
  assert.match(prompt, /focus_task_unresolved_dependencies: task_dep/);
  assert.match(prompt, /## Discuss Tool Usage Guide/);
  assert.match(prompt, /non-focus task reporting is allowed only when dependencies are already ready/i);
  assert.match(prompt, /never report IN_PROGRESS\/DONE\/MAY_BE_DONE for dependency-blocked tasks/i);
});
