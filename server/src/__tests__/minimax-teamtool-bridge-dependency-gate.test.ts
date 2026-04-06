import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { createProject, ensureProjectRuntime } from "../data/repository/project/runtime-repository.js";
import { createMiniMaxTeamToolBridge, TeamToolBridgeError } from "../services/minimax-teamtool-bridge.js";
import { handleTaskAction } from "../services/task-action-service.js";

test("project teamtool bridge maps dependency-not-ready report error with actionable hint", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-teamtool-bridge-dep-gate-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  const { project } = await createProject(dataRoot, {
    projectId: "teamtool_bridge_dep_gate",
    name: "TeamTool Bridge Dep Gate",
    workspacePath
  });
  const paths = await ensureProjectRuntime(dataRoot, project.projectId);

  await handleTaskAction(dataRoot, project, paths, {
    action_type: "TASK_CREATE",
    from_agent: "manager",
    from_session_id: "manager-system",
    task_id: "user-root-1",
    task_kind: "USER_ROOT",
    parent_task_id: `${project.projectId}-root`,
    title: "User Root",
    owner_role: "manager"
  });
  await handleTaskAction(dataRoot, project, paths, {
    action_type: "TASK_CREATE",
    from_agent: "manager",
    from_session_id: "manager-system",
    task_id: "dep-task",
    task_kind: "EXECUTION",
    parent_task_id: "user-root-1",
    root_task_id: "user-root-1",
    title: "Dependency Task",
    owner_role: "dev"
  });
  await handleTaskAction(dataRoot, project, paths, {
    action_type: "TASK_CREATE",
    from_agent: "manager",
    from_session_id: "manager-system",
    task_id: "target-task",
    task_kind: "EXECUTION",
    parent_task_id: "user-root-1",
    root_task_id: "user-root-1",
    title: "Target Task",
    owner_role: "dev",
    dependencies: ["dep-task"]
  });

  const bridge = createMiniMaxTeamToolBridge({
    dataRoot,
    project,
    paths,
    agentRole: "dev",
    sessionId: "sess-dev-1",
    activeTaskId: "target-task"
  });

  await assert.rejects(
    bridge.taskAction({
      action_type: "TASK_REPORT",
      from_agent: "dev",
      from_session_id: "sess-dev-1",
      results: [{ task_id: "target-task", outcome: "DONE", summary: "premature done" }]
    }),
    (error: unknown) => {
      assert.equal(error instanceof TeamToolBridgeError, true);
      const bridgeError = error as TeamToolBridgeError;
      assert.equal(bridgeError.code, "TASK_DEPENDENCY_NOT_READY");
      assert.match(String(bridgeError.nextAction ?? ""), /dep-task/);
      return true;
    }
  );
});
