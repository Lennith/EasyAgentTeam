import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("workflow task-actions support create/discuss/report with partial apply and cross-role restrictions", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-task-actions-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;
  const fetch = globalThis.fetch;

  try {
    const createTemplate = await fetch(`${baseUrl}/api/workflow-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "task_action_tpl",
        name: "Task Action Template",
        route_table: {
          lead: ["architect"],
          architect: ["lead"]
        },
        tasks: [
          { task_id: "task_dep", title: "Task Dep", owner_role: "lead" },
          { task_id: "task_a", title: "Task A", owner_role: "lead", dependencies: ["task_dep"] },
          { task_id: "task_b", title: "Task B", owner_role: "architect", dependencies: ["task_a"] }
        ]
      })
    });
    assert.equal(createTemplate.status, 201);

    const createRun = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "task_action_tpl",
        run_id: "task_action_run_01",
        workspace_path: workspaceRoot
      })
    });
    assert.equal(createRun.status, 201);

    const startRun = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/start`, { method: "POST" });
    assert.equal(startRun.status, 200);

    const registerArchitect = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "architect", session_id: "session-architect-01" })
    });
    assert.equal(registerArchitect.status, 201);

    const createTask = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "architect",
        from_session_id: "session-architect-01",
        task: {
          task_id: "task_c",
          title: "Task C",
          owner_role: "architect",
          parent_task_id: "task_b",
          dependencies: ["task_a", "task_dep"]
        }
      })
    });
    assert.equal(createTask.status, 200);
    const createTaskPayload = (await createTask.json()) as {
      success: boolean;
      createdTaskId?: string;
    };
    assert.equal(createTaskPayload.success, true);
    assert.equal(createTaskPayload.createdTaskId, "task_c");

    const runtimeTree = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/task-tree-runtime`);
    assert.equal(runtimeTree.status, 200);
    const runtimeTreePayload = (await runtimeTree.json()) as {
      nodes: Array<{ taskId: string; dependencies?: string[] }>;
    };
    const taskCNode = runtimeTreePayload.nodes.find((node) => node.taskId === "task_c");
    assert.ok(taskCNode);
    assert.deepEqual(taskCNode?.dependencies ?? [], ["task_a", "task_dep"]);

    const createInvalidParentDependency = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "architect",
        from_session_id: "session-architect-01",
        task: {
          task_id: "task_invalid_parent_dep",
          title: "Task Invalid Parent Dependency",
          owner_role: "architect",
          parent_task_id: "task_c",
          dependencies: ["task_c"]
        }
      })
    });
    assert.equal(createInvalidParentDependency.status, 409);
    const createInvalidParentDependencyPayload = (await createInvalidParentDependency.json()) as {
      error_code?: string;
      error?: {
        details?: {
          task_id?: string;
          parent_task_id?: string | null;
          ancestor_task_ids?: string[];
          forbidden_dependency_ids?: string[];
        };
      };
    };
    assert.equal(createInvalidParentDependencyPayload.error_code, "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN");
    assert.equal(createInvalidParentDependencyPayload.error?.details?.task_id, "task_invalid_parent_dep");
    assert.equal(createInvalidParentDependencyPayload.error?.details?.parent_task_id, "task_c");
    assert.equal(createInvalidParentDependencyPayload.error?.details?.ancestor_task_ids?.includes("task_b"), true);
    assert.deepEqual(createInvalidParentDependencyPayload.error?.details?.forbidden_dependency_ids ?? [], ["task_c"]);

    const createInvalidRoleTask = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "architect",
        from_session_id: "session-architect-01",
        task: {
          task_id: "task_invalid_role",
          title: "Task Invalid Role",
          owner_role: "ghost_role",
          dependencies: ["task_a"]
        }
      })
    });
    assert.equal(createInvalidRoleTask.status, 409);
    const createInvalidRolePayload = (await createInvalidRoleTask.json()) as {
      error_code?: string;
      message?: string;
      hint?: string | null;
      details?: { owner_role?: string; available_roles?: string[] };
    };
    assert.equal(createInvalidRolePayload.error_code, "TASK_OWNER_ROLE_NOT_FOUND");
    assert.match(String(createInvalidRolePayload.message ?? ""), /ghost_role/);
    assert.match(String(createInvalidRolePayload.hint ?? ""), /route_targets_get/i);

    const discussRequest = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_DISCUSS_REQUEST",
        from_agent: "lead",
        from_session_id: "session-lead-01",
        to_role: "architect",
        task_id: "task_b",
        content: "Please justify the architecture trade-offs.",
        discuss: {
          thread_id: "thread-01",
          request_id: "req-discuss-01"
        }
      })
    });
    assert.equal(discussRequest.status, 200);
    const discussPayload = (await discussRequest.json()) as { success: boolean; messageId?: string };
    assert.equal(discussPayload.success, true);
    assert.equal(typeof discussPayload.messageId, "string");

    const timeline = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/agent-io/timeline?limit=200`);
    assert.equal(timeline.status, 200);
    const timelinePayload = (await timeline.json()) as {
      items: Array<{ kind?: string; messageType?: string }>;
    };
    assert.equal(
      timelinePayload.items.some((item) => item.kind === "task_discuss" || item.messageType === "TASK_DISCUSS_REQUEST"),
      true
    );

    const dependencyNotReadyReport = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "architect",
        from_session_id: "session-architect-01",
        results: [{ task_id: "task_b", outcome: "DONE", summary: "premature done" }]
      })
    });
    assert.equal(dependencyNotReadyReport.status, 409);
    const dependencyNotReadyPayload = (await dependencyNotReadyReport.json()) as {
      error_code?: string;
      error?: { details?: { task_id?: string; dependency_task_ids?: string[] } };
      hint?: string | null;
    };
    assert.equal(dependencyNotReadyPayload.error_code, "TASK_DEPENDENCY_NOT_READY");
    assert.equal(dependencyNotReadyPayload.error?.details?.task_id, "task_b");
    assert.deepEqual(dependencyNotReadyPayload.error?.details?.dependency_task_ids ?? [], ["task_a"]);
    assert.match(String(dependencyNotReadyPayload.hint ?? ""), /Wait until/);

    const blockedDependencyReport = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "architect",
        from_session_id: "session-architect-01",
        results: [{ task_id: "task_b", outcome: "BLOCKED_DEP", summary: "waiting task_a", blockers: ["task_a"] }]
      })
    });
    assert.equal(blockedDependencyReport.status, 200);

    const partialReport = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "lead",
        from_session_id: "session-lead-01",
        results: [
          { task_id: "task_dep", outcome: "DONE", summary: "done" },
          { task_id: "task_a", outcome: "DONE", summary: "done after dependency in same batch" },
          { task_id: "task_missing", outcome: "DONE", summary: "missing" }
        ]
      })
    });
    assert.equal(partialReport.status, 200);
    const partialPayload = (await partialReport.json()) as {
      partialApplied: boolean;
      appliedTaskIds: string[];
      rejectedResults: Array<{ taskId: string; reasonCode: string }>;
    };
    assert.equal(partialPayload.partialApplied, true);
    assert.deepEqual(partialPayload.appliedTaskIds, ["task_dep", "task_a"]);
    assert.equal(partialPayload.rejectedResults.length, 1);
    assert.equal(partialPayload.rejectedResults[0].taskId, "task_missing");
    assert.equal(partialPayload.rejectedResults[0].reasonCode, "TASK_NOT_FOUND");

    const completeTaskC = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "architect",
        from_session_id: "session-architect-01",
        results: [{ task_id: "task_c", outcome: "DONE", summary: "non-focus but dependency-ready completion" }]
      })
    });
    assert.equal(completeTaskC.status, 200);

    const crossRoleReport = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "architect",
        from_session_id: "session-architect-01",
        results: [{ task_id: "task_a", outcome: "DONE", summary: "cross role" }]
      })
    });
    assert.equal(crossRoleReport.status, 200);
    const crossRolePayload = (await crossRoleReport.json()) as {
      partialApplied: boolean;
      appliedTaskIds: string[];
      rejectedResults: Array<{ taskId: string; reasonCode: string }>;
    };
    assert.equal(crossRolePayload.partialApplied, true);
    assert.deepEqual(crossRolePayload.appliedTaskIds, []);
    assert.equal(crossRolePayload.rejectedResults.length, 1);
    assert.equal(crossRolePayload.rejectedResults[0].taskId, "task_a");
    assert.equal(crossRolePayload.rejectedResults[0].reasonCode, "INVALID_TRANSITION");

    const stopRun = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/stop`, { method: "POST" });
    assert.equal(stopRun.status, 200);

    const reportAfterStop = await fetch(`${baseUrl}/api/workflow-runs/task_action_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "lead",
        results: [{ task_id: "task_b", outcome: "DONE" }]
      })
    });
    assert.equal(reportAfterStop.status, 409);
    const stoppedPayload = (await reportAfterStop.json()) as { error_code?: string };
    assert.equal(stoppedPayload.error_code, "RUN_NOT_RUNNING");
  } finally {
    await server.close();
  }
});
