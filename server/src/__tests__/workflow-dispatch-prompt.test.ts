import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowRunRecord } from "../domain/models.js";
import { createWorkflowOrchestratorService } from "../services/orchestrator/index.js";
import { createProviderRegistry } from "../services/provider-runtime.js";

test("workflow dispatch prompt includes team/shared workspace contract", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-dispatch-prompt-"));
  const service = createWorkflowOrchestratorService(tempRoot, createProviderRegistry()) as unknown as {
    buildDispatchPrompt(input: {
      run: WorkflowRunRecord;
      role: string;
      taskId: string | null;
      dispatchKind: "task" | "message";
      message: null;
      taskState: "READY" | null;
      runtimeTasks: Array<{ taskId: string; state: string; blockedBy?: string[] }>;
      rolePrompt?: string;
    }): string;
  };

  const run = {
    runId: "wf_prompt_run_01",
    name: "Workflow Prompt Run",
    description: "verify prompt workspace semantics",
    workspacePath: "D:\\AgentWorkSpace\\DemoWorkflow",
    tasks: [
      {
        taskId: "task_a",
        ownerRole: "dev_agent",
        resolvedTitle: "Implement feature A",
        parentTaskId: null,
        dependencies: [],
        acceptance: ["all tests pass"],
        artifacts: ["src/featureA.ts"]
      }
    ]
  } as unknown as WorkflowRunRecord;

  const prompt = service.buildDispatchPrompt({
    run,
    role: "dev_agent",
    taskId: "task_a",
    dispatchKind: "task",
    message: null,
    taskState: "READY",
    runtimeTasks: [
      { taskId: "task_a", state: "READY", blockedBy: [] },
      { taskId: "task_blocked", state: "BLOCKED_DEP", blockedBy: ["task_a"] }
    ],
    rolePrompt: "Role: dev_agent"
  });

  assert.match(prompt, /TeamWorkSpace=D:\\AgentWorkSpace\\DemoWorkflow/);
  assert.match(prompt, /YourWorkspace=D:\\AgentWorkSpace\\DemoWorkflow\\Agents\\dev_agent/);
  assert.match(
    prompt,
    /Shared deliverables must be written under TeamWorkSpace\/docs\/\*\* or TeamWorkSpace\/src\/\*\*/
  );
  assert.match(prompt, /Focus task id \(this turn\): task_a/);
  assert.match(prompt, /This turn should operate on: task_a/);
  assert.match(prompt, /Visible blocked tasks \(same role\):/);
  assert.match(prompt, /Never report IN_PROGRESS\/DONE for tasks whose dependencies are not ready/);
  assert.match(prompt, /Non-focus task report is allowed only when dependencies are already satisfied/);
});

test("workflow dispatch prompt requires execution subtask before decomposition phase can finish", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-dispatch-prompt-"));
  const service = createWorkflowOrchestratorService(tempRoot, createProviderRegistry()) as unknown as {
    buildDispatchPrompt(input: {
      run: WorkflowRunRecord;
      role: string;
      taskId: string | null;
      dispatchKind: "task" | "message";
      message: null;
      taskState: "READY" | null;
      runtimeTasks: Array<{ taskId: string; state: string; blockedBy?: string[] }>;
      rolePrompt?: string;
    }): string;
  };

  const run = {
    runId: "wf_prompt_run_02",
    name: "Workflow Prompt Run",
    description: "verify decomposition prompt semantics",
    workspacePath: "D:\\AgentWorkSpace\\DemoWorkflow",
    tasks: [
      {
        taskId: "wf_engineering_decomposition",
        ownerRole: "e2e_mgr_rd_lead",
        title: "RD lead decomposes engineering plan and ownership",
        resolvedTitle: "RD lead decomposes engineering plan and ownership",
        parentTaskId: null,
        dependencies: [],
        acceptance: [
          "Break down Android/ML/QA/Release work packages.",
          "Include dependency order and integration checkpoints."
        ],
        artifacts: ["docs/engineering/01_decomposition.md"]
      }
    ]
  } as unknown as WorkflowRunRecord;

  const prompt = service.buildDispatchPrompt({
    run,
    role: "e2e_mgr_rd_lead",
    taskId: "wf_engineering_decomposition",
    dispatchKind: "task",
    message: null,
    taskState: "READY",
    runtimeTasks: [{ taskId: "wf_engineering_decomposition", state: "READY", blockedBy: [] }],
    rolePrompt: "Role: e2e_mgr_rd_lead"
  });

  assert.match(prompt, /no execution subtask exists yet/i);
  assert.match(prompt, /Before reporting DONE, create at least one concrete non-manager execution subtask/i);
  assert.match(prompt, /use the focus task as parent_task_id/i);
  assert.match(prompt, /Do not create QA\/release subtasks that depend on future phase tasks/i);
  assert.match(
    prompt,
    /If the focus task is not explicitly a planning\/decomposition task, execute directly on the focus task and report progress there\. Do not delegate through new subtasks/i
  );
  assert.match(
    prompt,
    /Non-decomposition design\/specification phases must hand off downstream work through shared artifacts and discuss messages/i
  );
  assert.match(
    prompt,
    /If the focus task is already a delegated execution subtask that you own, treat it as the execution unit/i
  );
});
