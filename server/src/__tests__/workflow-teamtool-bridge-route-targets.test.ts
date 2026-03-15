import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { upsertWorkflowSession } from "../data/workflow-run-store.js";
import type { WorkflowRunRecord } from "../domain/models.js";
import { createWorkflowMiniMaxTeamToolBridge } from "../services/workflow-minimax-teamtool-bridge.js";

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
