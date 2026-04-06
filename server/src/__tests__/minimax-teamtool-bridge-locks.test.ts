import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject, ensureProjectRuntime } from "../data/repository/project/runtime-repository.js";
import type { WorkflowRunRecord } from "../domain/models.js";
import { createMiniMaxTeamToolBridge } from "../services/minimax-teamtool-bridge.js";
import { createWorkflowMiniMaxTeamToolBridge } from "../services/workflow-minimax-teamtool-bridge.js";

test("project and workflow teamtool bridges share the same lock lifecycle behavior", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-teamtool-bridge-locks-"));

  const projectDataRoot = path.join(tempRoot, "project-data");
  const projectWorkspacePath = path.join(tempRoot, "project-workspace");
  const created = await createProject(projectDataRoot, {
    projectId: "teamtool_lock_project",
    name: "TeamTool Lock Project",
    workspacePath: projectWorkspacePath
  });
  const projectPaths = await ensureProjectRuntime(projectDataRoot, created.project.projectId);
  const projectBridge = createMiniMaxTeamToolBridge({
    dataRoot: projectDataRoot,
    project: created.project,
    paths: projectPaths,
    agentRole: "dev",
    sessionId: "sess-project-1"
  });

  const workflowDataRoot = path.join(tempRoot, "workflow-data");
  const workflowWorkspacePath = path.join(tempRoot, "workflow-workspace");
  await mkdir(workflowWorkspacePath, { recursive: true });
  const run: WorkflowRunRecord = {
    schemaVersion: "2.0",
    runId: "wf_lock_run_01",
    templateId: "wf_tpl_01",
    name: "Workflow Lock Run",
    workspacePath: workflowWorkspacePath,
    tasks: [],
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workflowBridge = createWorkflowMiniMaxTeamToolBridge({
    dataRoot: workflowDataRoot,
    run,
    agentRole: "lead",
    sessionId: "sess-workflow-1",
    applyTaskAction: async () => ({ ok: true }),
    sendRunMessage: async () => ({ ok: true })
  });

  const projectAcquire = (await projectBridge.lockAcquire({
    lock_key: "src/project-a.ts",
    ttl_seconds: 120
  })) as { result: string };
  const workflowAcquire = (await workflowBridge.lockAcquire({
    lock_key: "src/workflow-a.ts",
    ttl_seconds: 120
  })) as { result: string };
  assert.equal(projectAcquire.result, "acquired");
  assert.equal(workflowAcquire.result, "acquired");

  const projectList = (await projectBridge.lockList()) as { total: number };
  const workflowList = (await workflowBridge.lockList()) as { total: number };
  assert.equal(projectList.total, 1);
  assert.equal(workflowList.total, 1);

  const projectRenew = (await projectBridge.lockRenew({
    lock_key: "src/project-a.ts"
  })) as { result: string };
  const workflowRenew = (await workflowBridge.lockRenew({
    lock_key: "src/workflow-a.ts"
  })) as { result: string };
  assert.equal(projectRenew.result, "renewed");
  assert.equal(workflowRenew.result, "renewed");

  const projectRelease = (await projectBridge.lockRelease({
    lock_key: "src/project-a.ts"
  })) as { result: string };
  const workflowRelease = (await workflowBridge.lockRelease({
    lock_key: "src/workflow-a.ts"
  })) as { result: string };
  assert.equal(projectRelease.result, "released");
  assert.equal(workflowRelease.result, "released");
});
