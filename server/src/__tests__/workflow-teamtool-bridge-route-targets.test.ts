import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { upsertWorkflowSession } from "../data/repository/workflow/runtime-repository.js";
import type { WorkflowRunRecord } from "../domain/models.js";
import {
  createWorkflowMiniMaxTeamToolBridge,
  TeamToolBridgeError
} from "../services/workflow-minimax-teamtool-bridge.js";

test("workflow route_targets_get only uses current run role scope", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-route-targets-"));
  const workspacePath = path.join(tempRoot, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const run: WorkflowRunRecord = {
    schemaVersion: "2.0",
    runId: "wf_route_targets_run_01",
    templateId: "wf_tpl_01",
    name: "Workflow Route Targets",
    workspacePath,
    routeTable: {
      lead: ["architect"],
      architect: ["lead"]
    },
    tasks: [
      {
        taskId: "task_a",
        title: "Task A",
        resolvedTitle: "Task A",
        ownerRole: "lead"
      },
      {
        taskId: "task_b",
        title: "Task B",
        resolvedTitle: "Task B",
        ownerRole: "rogue_task_owner",
        dependencies: ["task_a"]
      }
    ],
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await upsertWorkflowSession(tempRoot, run.runId, {
    sessionId: "session-lead-01",
    role: "lead",
    status: "idle"
  });
  await upsertWorkflowSession(tempRoot, run.runId, {
    sessionId: "session-architect-01",
    role: "architect",
    status: "idle"
  });

  const bridge = createWorkflowMiniMaxTeamToolBridge({
    dataRoot: tempRoot,
    run,
    agentRole: "lead",
    sessionId: "session-lead-01",
    applyTaskAction: async () => ({ ok: true }),
    sendRunMessage: async () => ({ ok: true })
  });

  const payload = (await bridge.getRouteTargets("lead")) as {
    enabledAgents: string[];
    allowedTargets: Array<{ agentId: string }>;
    fromAgentEnabled: boolean;
  };
  const enabled = new Set(payload.enabledAgents);
  assert.equal(payload.fromAgentEnabled, true);
  assert.equal(enabled.has("lead"), true);
  assert.equal(enabled.has("architect"), true);
  assert.equal(enabled.has("rogue_task_owner"), false);
  assert.deepEqual(
    payload.allowedTargets.map((item) => item.agentId),
    ["architect"]
  );
});

test("workflow task bridge surfaces TASK_DEPENDENCY_NOT_READY next_action for agent correction", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-bridge-dep-not-ready-"));
  const workspacePath = path.join(tempRoot, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const run: WorkflowRunRecord = {
    schemaVersion: "2.0",
    runId: "wf_route_targets_run_02",
    templateId: "wf_tpl_02",
    name: "Workflow Route Targets 2",
    workspacePath,
    routeTable: {
      lead: ["architect"],
      architect: ["lead"]
    },
    tasks: [{ taskId: "task_a", title: "Task A", resolvedTitle: "Task A", ownerRole: "lead" }],
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const bridge = createWorkflowMiniMaxTeamToolBridge({
    dataRoot: tempRoot,
    run,
    agentRole: "lead",
    sessionId: "session-lead-01",
    applyTaskAction: async () => {
      const error = new Error("dependency not ready") as Error & {
        status: number;
        code: string;
        nextAction: string;
        details: Record<string, unknown>;
      };
      error.status = 409;
      error.code = "TASK_DEPENDENCY_NOT_READY";
      error.nextAction = "Task 'task_a' is blocked by dependencies [task_dep]. Wait until dependency is DONE.";
      error.details = { task_id: "task_a", dependency_task_ids: ["task_dep"] };
      throw error;
    },
    sendRunMessage: async () => ({ ok: true })
  });

  await assert.rejects(
    bridge.taskAction({
      action_type: "TASK_REPORT",
      from_agent: "lead",
      from_session_id: "session-lead-01",
      results: [{ task_id: "task_a", outcome: "DONE" }]
    }),
    (error: unknown) => {
      assert.equal(error instanceof TeamToolBridgeError, true);
      const bridgeError = error as TeamToolBridgeError;
      assert.equal(bridgeError.code, "TASK_DEPENDENCY_NOT_READY");
      assert.match(String(bridgeError.nextAction ?? ""), /task_dep/);
      return true;
    }
  );
});

test("workflow task bridge surfaces TASK_EXISTS with recoverable next_action", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-bridge-task-exists-"));
  const workspacePath = path.join(tempRoot, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const run: WorkflowRunRecord = {
    schemaVersion: "2.0",
    runId: "wf_route_targets_run_03",
    templateId: "wf_tpl_03",
    name: "Workflow Route Targets 3",
    workspacePath,
    routeTable: { lead: ["architect"], architect: ["lead"] },
    tasks: [{ taskId: "task_existing", title: "Task Existing", resolvedTitle: "Task Existing", ownerRole: "lead" }],
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const bridge = createWorkflowMiniMaxTeamToolBridge({
    dataRoot: tempRoot,
    run,
    agentRole: "lead",
    sessionId: "session-lead-01",
    applyTaskAction: async () => {
      const error = new Error("task already exists") as Error & {
        status: number;
        code: string;
        nextAction: string;
      };
      error.status = 409;
      error.code = "TASK_EXISTS";
      error.nextAction = "Do not recreate the same task_id. Inspect the existing task owner, parent, and state first.";
      throw error;
    },
    sendRunMessage: async () => ({ ok: true })
  });

  await assert.rejects(
    bridge.taskAction({
      action_type: "TASK_CREATE",
      from_agent: "lead",
      from_session_id: "session-lead-01",
      task: {
        task_id: "task_existing",
        title: "Task Existing",
        owner_role: "lead"
      }
    }),
    (error: unknown) => {
      assert.equal(error instanceof TeamToolBridgeError, true);
      const bridgeError = error as TeamToolBridgeError;
      assert.equal(bridgeError.code, "TASK_EXISTS");
      assert.match(String(bridgeError.nextAction ?? ""), /Do not recreate the same task_id/i);
      return true;
    }
  );
});
