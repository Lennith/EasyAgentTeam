import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowRunRecord } from "../domain/models.js";
import { createWorkflowOrchestratorService } from "../services/workflow-orchestrator-service.js";

test("workflow dispatch prompt includes team/shared workspace contract", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-dispatch-prompt-"));
  const service = createWorkflowOrchestratorService(tempRoot) as unknown as {
    buildDispatchPrompt(input: {
      run: WorkflowRunRecord;
      role: string;
      taskId: string | null;
      dispatchKind: "task" | "message";
      message: null;
      taskState: "READY" | null;
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
    rolePrompt: "Role: dev_agent"
  });

  assert.match(prompt, /TeamWorkSpace=D:\\AgentWorkSpace\\DemoWorkflow/);
  assert.match(prompt, /YourWorkspace=D:\\AgentWorkSpace\\DemoWorkflow\\Agents\\dev_agent/);
  assert.match(
    prompt,
    /Shared deliverables must be written under TeamWorkSpace\/docs\/\*\* or TeamWorkSpace\/src\/\*\*/
  );
});
