import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

async function seedAgent(baseUrl: string, agentId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      display_name: agentId,
      prompt: `${agentId} prompt`
    })
  });
  assert.equal(res.status, 201);
}

test("retired task endpoints return 410", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-retired-endpoints-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "retiredcheck",
        name: "Retired Check",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    const [handoffRes, reportsRes, tasksRes] = await Promise.all([
      fetch(`${baseUrl}/api/projects/retiredcheck/agent-handoff`, { method: "POST" }),
      fetch(`${baseUrl}/api/projects/retiredcheck/reports`, { method: "POST" }),
      fetch(`${baseUrl}/api/projects/retiredcheck/tasks`)
    ]);
    assert.equal(handoffRes.status, 410);
    assert.equal(reportsRes.status, 410);
    assert.equal(tasksRes.status, 410);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("task-actions create task tree and TASK_REPORT enforces progress validation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-task-actions-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  const app = createApp({ dataRoot });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (const agentId of ["manager", "dev"]) {
      await seedAgent(baseUrl, agentId);
    }

    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "taskactions",
        name: "Task Actions",
        workspace_path: workspacePath,
        agent_ids: ["dev"]
      })
    });
    assert.equal(projectRes.status, 201);

    const sessionRes = await fetch(`${baseUrl}/api/projects/taskactions/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-dev", role: "dev" })
    });
    assert.equal([200, 201].includes(sessionRes.status), true);
    const sessionPayload = (await sessionRes.json()) as { session: { sessionId: string } };
    const devSessionId = sessionPayload.session.sessionId;

    const createRoot = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "project-root-taskactions",
        task_kind: "PROJECT_ROOT",
        title: "Project Root",
        owner_role: "manager"
      })
    });
    assert.equal(createRoot.status, 201);

    const createUserRoot = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "user-root-1",
        task_kind: "USER_ROOT",
        parent_task_id: "project-root-taskactions",
        title: "User Root",
        owner_role: "manager"
      })
    });
    assert.equal(createUserRoot.status, 201);

    const createExec = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "exec-task-1",
        task_kind: "EXECUTION",
        parent_task_id: "user-root-1",
        root_task_id: "user-root-1",
        title: "Implement feature",
        owner_role: "dev"
      })
    });
    assert.equal(createExec.status, 201);

    const createBaseDependency = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "exec-dep-base",
        task_kind: "EXECUTION",
        parent_task_id: "user-root-1",
        root_task_id: "user-root-1",
        title: "Base Dependency",
        owner_role: "dev"
      })
    });
    assert.equal(createBaseDependency.status, 201);

    const createParentTask = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "exec-parent-task",
        task_kind: "EXECUTION",
        parent_task_id: "user-root-1",
        root_task_id: "user-root-1",
        title: "Parent Task",
        owner_role: "dev",
        dependencies: ["exec-dep-base"]
      })
    });
    assert.equal(createParentTask.status, 201);

    const createChildTask = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "exec-child-task",
        task_kind: "EXECUTION",
        parent_task_id: "exec-parent-task",
        root_task_id: "user-root-1",
        title: "Child Task",
        owner_role: "dev",
        dependencies: ["exec-task-1", "exec-dep-base"]
      })
    });
    assert.equal(createChildTask.status, 201);

    const createInvalidParentDependency = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "exec-invalid-parent-dep",
        task_kind: "EXECUTION",
        parent_task_id: "exec-task-1",
        root_task_id: "user-root-1",
        title: "Invalid parent dependency",
        owner_role: "dev",
        dependencies: ["exec-task-1"]
      })
    });
    assert.equal(createInvalidParentDependency.status, 409);
    const invalidPayload = (await createInvalidParentDependency.json()) as { error_code?: string };
    assert.equal(invalidPayload.error_code, "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN");

    const assignInvalidParentDependency = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_ASSIGN",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "exec-task-1",
        owner_role: "dev",
        dependencies: ["user-root-1"]
      })
    });
    assert.equal(assignInvalidParentDependency.status, 409);
    const invalidAssignPayload = (await assignInvalidParentDependency.json()) as { error_code?: string };
    assert.equal(invalidAssignPayload.error_code, "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN");

    const updateInvalidParentDependency = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_UPDATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "exec-task-1",
        dependencies: ["user-root-1"]
      })
    });
    assert.equal(updateInvalidParentDependency.status, 409);
    const invalidUpdatePayload = (await updateInvalidParentDependency.json()) as { error_code?: string };
    assert.equal(invalidUpdatePayload.error_code, "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN");

    const outboxDir = path.join(dataRoot, "projects", "taskactions", "collab", "outbox");
    const outboxFiles = await fs.readdir(outboxDir).catch(() => [] as string[]);
    assert.equal(
      outboxFiles.some((name) => name === "task-dispatch-buffer-manager-system.jsonl"),
      false
    );

    const treeRes = await fetch(`${baseUrl}/api/projects/taskactions/task-tree`);
    assert.equal(treeRes.status, 200);
    const tree = (await treeRes.json()) as {
      nodes: Array<{ task_id: string; task_detail_id?: string; state: string; dependencies?: string[] }>;
      edges: Array<{ edge_type: string; from_task_id: string; to_task_id: string }>;
    };
    const nodeIds = new Set(tree.nodes.map((item) => item.task_id));
    assert.equal(nodeIds.has("project-root-taskactions"), true);
    assert.equal(nodeIds.has("user-root-1"), true);
    assert.equal(nodeIds.has("exec-task-1"), true);
    const parentEdge = tree.edges.find(
      (edge) =>
        edge.edge_type === "PARENT_CHILD" && edge.from_task_id === "user-root-1" && edge.to_task_id === "exec-task-1"
    );
    assert.ok(parentEdge);
    const execNode = tree.nodes.find((item) => item.task_id === "exec-task-1");
    assert.ok(execNode);
    assert.equal(execNode?.task_detail_id, "exec-task-1");
    const childNode = tree.nodes.find((item) => item.task_id === "exec-child-task");
    assert.ok(childNode);
    assert.deepEqual(childNode?.dependencies ?? [], ["exec-dep-base", "exec-task-1"]);

    const inProgressAccepted = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "dev",
        from_session_id: devSessionId,
        summary: "implemented parser skeleton",
        results: [{ task_id: "exec-task-1", outcome: "IN_PROGRESS", summary: "implemented parser skeleton" }]
      })
    });
    assert.equal(inProgressAccepted.status, 201);
    const treeAfterProgressRes = await fetch(`${baseUrl}/api/projects/taskactions/task-tree`);
    assert.equal(treeAfterProgressRes.status, 200);
    const treeAfterProgress = (await treeAfterProgressRes.json()) as {
      nodes: Array<{ task_id: string; state: string }>;
    };
    const inProgressNode = treeAfterProgress.nodes.find((item) => item.task_id === "exec-task-1");
    assert.equal(inProgressNode?.state, "IN_PROGRESS");

    // DONE 閹躲儱鎲￠張?report_content閿涘瞼骞囬崷銊︽杹鐎逛粙鐛欑拠渚婄礉娑撳秹娓剁憰?progress.md 娑旂喕鍏橀柅姘崇箖
    const retiredModeRejected = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "dev",
        from_session_id: devSessionId,
        task_id: "exec-task-1",
        report_mode: "DONE",
        report_content: "done"
      })
    });
    assert.equal(retiredModeRejected.status, 400);

    const retiredOutcomeRejected = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "dev",
        from_session_id: devSessionId,
        summary: "retired outcome",
        results: [{ task_id: "exec-task-1", outcome: "PARTIAL", summary: "old format" }]
      })
    });
    assert.equal(retiredOutcomeRejected.status, 400);

    const progressPath = path.join(workspacePath, "Agents", "dev", "progress.md");
    await fs.writeFile(
      progressPath,
      [
        "# Progress - dev",
        "",
        "status: DONE",
        "task: exec-task-1",
        "changed: src/task.ts",
        "evidence: unit tests passed"
      ].join("\n"),
      "utf8"
    );

    // 缁楊兛绔村▎?DONE 閹躲儱鎲″鑼病鐏忓棔鎹㈤崝鈩冩纯閺傞璐?DONE
    // 缁楊兛绨╁▎锛勬暏 results 閺嶇厧绱￠幓鎰唉 DONE閿涘奔鎹㈤崝鈥冲嚒缂佸繑妲?DONE閿涘瞼濮搁幀浣圭梾閸欐ê瀵查敍宀冪箲閸?409
    // (鏉╂瑦妲稿锝団€橀惃鍕攽娑撶尨绱濋崶鐘辫礋娴犺濮熼悩鑸碘偓浣圭梾閺堝鏁奸崣?
    const reportAccepted = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "dev",
        from_session_id: devSessionId,
        summary: "done",
        results: [{ task_id: "exec-task-1", outcome: "DONE", summary: "implemented" }]
      })
    });
    assert.equal(reportAccepted.status, 201);

    const reportNoop = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "dev",
        from_session_id: devSessionId,
        summary: "done again",
        results: [{ task_id: "exec-task-1", outcome: "DONE", summary: "no new update" }]
      })
    });
    assert.equal(reportNoop.status, 201);

    const staleRollback = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "dev",
        from_session_id: devSessionId,
        summary: "attempt rollback from done",
        results: [{ task_id: "exec-task-1", outcome: "IN_PROGRESS", summary: "attempt rollback from done" }]
      })
    });
    assert.equal(staleRollback.status, 409);
    const stalePayload = (await staleRollback.json()) as { error_code?: string };
    assert.equal(stalePayload.error_code, "TASK_STATE_STALE");

    const createExec2 = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "exec-task-2",
        task_kind: "EXECUTION",
        parent_task_id: "user-root-1",
        root_task_id: "user-root-1",
        title: "Second task",
        owner_role: "dev"
      })
    });
    assert.equal(createExec2.status, 201);

    const createExec3 = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "exec-task-3",
        task_kind: "EXECUTION",
        parent_task_id: "user-root-1",
        root_task_id: "user-root-1",
        title: "Third task",
        owner_role: "dev",
        dependencies: ["exec-task-2"]
      })
    });
    assert.equal(createExec3.status, 201);

    const blockTask2 = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "dev",
        from_session_id: devSessionId,
        summary: "waiting dependency",
        results: [
          {
            task_id: "exec-task-2",
            outcome: "BLOCKED_DEP",
            summary: "waiting dependency",
            blockers: ["waiting dependency"]
          }
        ]
      })
    });
    assert.equal(blockTask2.status, 201);

    const reportDependencyNotReady = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "dev",
        from_session_id: devSessionId,
        summary: "mixed report with unresolved dependency first",
        results: [
          { task_id: "exec-task-3", outcome: "DONE", summary: "premature done" },
          { task_id: "exec-task-2", outcome: "DONE", summary: "done now" }
        ]
      })
    });
    assert.equal(reportDependencyNotReady.status, 409);
    const dependencyNotReadyPayload = (await reportDependencyNotReady.json()) as {
      error_code?: string;
      error?: { details?: { task_id?: string; dependency_task_ids?: string[] } };
      hint?: string | null;
    };
    assert.equal(dependencyNotReadyPayload.error_code, "TASK_DEPENDENCY_NOT_READY");
    assert.equal(dependencyNotReadyPayload.error?.details?.task_id, "exec-task-3");
    assert.deepEqual(dependencyNotReadyPayload.error?.details?.dependency_task_ids ?? [], ["exec-task-2"]);
    assert.match(String(dependencyNotReadyPayload.hint ?? ""), /Wait for dependenc/i);

    const reportOrderedDependencyResolved = await fetch(`${baseUrl}/api/projects/taskactions/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "dev",
        from_session_id: devSessionId,
        summary: "ordered report resolves dependency in same batch",
        results: [
          { task_id: "exec-task-2", outcome: "DONE", summary: "dependency solved in same batch" },
          { task_id: "exec-task-3", outcome: "DONE", summary: "done after dependency solved in same batch" }
        ]
      })
    });
    assert.equal(reportOrderedDependencyResolved.status, 201);

    const treeAfterOrderedDependencyResolved = await fetch(`${baseUrl}/api/projects/taskactions/task-tree`);
    assert.equal(treeAfterOrderedDependencyResolved.status, 200);
    const treeAfterOrderedDependencyResolvedPayload = (await treeAfterOrderedDependencyResolved.json()) as {
      nodes: Array<{ task_id: string; state: string }>;
    };
    const execTask2StateAfterOrdered = treeAfterOrderedDependencyResolvedPayload.nodes.find(
      (item) => item.task_id === "exec-task-2"
    )?.state;
    const execTask3StateAfterOrdered = treeAfterOrderedDependencyResolvedPayload.nodes.find(
      (item) => item.task_id === "exec-task-3"
    )?.state;
    assert.equal(execTask2StateAfterOrdered, "DONE");
    assert.equal(execTask3StateAfterOrdered, "DONE");
    const timelineRes = await fetch(`${baseUrl}/api/projects/taskactions/agent-io/timeline`);
    assert.equal(timelineRes.status, 200);
    const timeline = (await timelineRes.json()) as {
      items: Array<{ kind: string; messageType?: string | null; toRole?: string | null; status?: string | null }>;
    };
    const taskActionReport = timeline.items.find(
      (item) => item.kind === "task_action" && item.messageType === "TASK_REPORT"
    );
    assert.ok(taskActionReport);
    assert.equal(taskActionReport?.toRole, "manager");

    const taskReportReceived = timeline.items.find(
      (item) => item.kind === "task_report" && item.messageType === "TASK_REPORT"
    );
    assert.ok(taskReportReceived);
    assert.equal(taskReportReceived?.toRole, "manager");
    const detailRes = await fetch(`${baseUrl}/api/projects/taskactions/tasks/exec-task-1/detail`);
    assert.equal(detailRes.status, 200);
    const detail = (await detailRes.json()) as {
      task_id: string;
      task_detail_id: string;
      created_by: { role: string | null };
      create_parameters: Record<string, unknown> | null;
      lifecycle: Array<{ event_type: string }>;
    };
    assert.equal(detail.task_id, "exec-task-1");
    assert.equal(detail.task_detail_id, "exec-task-1");
    assert.equal(detail.created_by.role, "manager");
    assert.equal((detail.create_parameters?.actionType as string | undefined) ?? "", "TASK_CREATE");
    assert.equal(
      detail.lifecycle.some((item) => item.event_type === "TASK_ACTION_RECEIVED"),
      true
    );
    assert.equal(
      detail.lifecycle.some((item) => item.event_type === "TASK_REPORT_APPLIED"),
      true
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
