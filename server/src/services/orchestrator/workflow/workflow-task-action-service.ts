import type {
  WorkflowRunRecord,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeState,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult
} from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import type { WorkflowMessageRouteResult, WorkflowRouteMessageInput } from "./workflow-message-routing-service.js";
import { applyWorkflowTaskCreateAction } from "./workflow-task-create-processing.js";
import { applyWorkflowTaskReportAction } from "./workflow-task-report-processing.js";
import type { WorkflowTaskActionPipelineState } from "./workflow-task-action-types.js";

interface WorkflowTaskActionServiceContext {
  repositories: WorkflowRepositoryBundle;
  loadRunOrThrow(runId: string): Promise<WorkflowRunRecord>;
  ensureRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  readConvergedRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  runWorkflowTransaction<T>(runId: string, operation: () => Promise<T>): Promise<T>;
  sendRunMessage(input: WorkflowRouteMessageInput): Promise<WorkflowMessageRouteResult>;
  buildSnapshot(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): WorkflowRunRuntimeSnapshot;
  createRuntimeError(
    message: string,
    code: string,
    status?: number,
    hint?: string,
    details?: Record<string, unknown>
  ): Error;
}

export class WorkflowTaskActionService {
  constructor(private readonly context: WorkflowTaskActionServiceContext) {}

  async applyTaskActions(
    runId: string,
    input: WorkflowTaskActionRequest
  ): Promise<Omit<WorkflowTaskActionResult, "requestId">> {
    const run = await this.context.loadRunOrThrow(runId);
    const runtime = await this.context.ensureRuntime(run);
    const actionType = input.actionType;
    const fromAgent = input.fromAgent?.trim() || "manager";

    await this.context.repositories.events.appendEvent(runId, {
      eventType: "TASK_ACTION_RECEIVED",
      source: fromAgent === "manager" ? "manager" : "agent",
      sessionId: input.fromSessionId,
      taskId: input.taskId,
      payload: {
        actionType,
        fromAgent,
        toRole: input.toRole ?? null,
        toSessionId: input.toSessionId ?? null,
        requestId: input.discuss?.requestId ?? null
      }
    });

    if (
      actionType === "TASK_DISCUSS_REQUEST" ||
      actionType === "TASK_DISCUSS_REPLY" ||
      actionType === "TASK_DISCUSS_CLOSED"
    ) {
      const message = await this.context.sendRunMessage({
        runId,
        fromAgent,
        fromSessionId: input.fromSessionId?.trim() || "manager-system",
        messageType: actionType,
        toRole: input.toRole,
        toSessionId: input.toSessionId,
        taskId: input.taskId,
        content: input.content?.trim() || "",
        requestId: input.discuss?.requestId,
        discuss: input.discuss
      });
      return {
        success: true,
        actionType,
        messageId: message.messageId,
        partialApplied: false,
        appliedTaskIds: [],
        rejectedResults: [],
        snapshot: this.context.buildSnapshot(run, runtime)
      };
    }

    return this.context.runWorkflowTransaction(runId, async () => {
      const currentRun = await this.context.loadRunOrThrow(runId);
      const currentRuntime = await this.context.readConvergedRuntime(currentRun);
      const baseState: WorkflowTaskActionPipelineState = {
        runId,
        input,
        fromAgent,
        actionType,
        currentRun,
        currentRuntime,
        byTask: new Map(currentRuntime.tasks.map((item) => [item.taskId, item])),
        runTaskById: new Map(currentRun.tasks.map((item) => [item.taskId, item]))
      };

      if (actionType === "TASK_CREATE") {
        return await applyWorkflowTaskCreateAction({
          state: baseState,
          repositories: this.context.repositories,
          buildSnapshot: (run, runtime) => this.context.buildSnapshot(run, runtime),
          createRuntimeError: (message, code, status, hint, details) =>
            this.context.createRuntimeError(message, code, status, hint, details)
        });
      }
      if (actionType === "TASK_REPORT") {
        if (currentRun.status !== "running") {
          throw this.context.createRuntimeError("run is not running", "RUN_NOT_RUNNING", 409);
        }
        return await applyWorkflowTaskReportAction({
          state: baseState,
          repositories: this.context.repositories,
          buildSnapshot: (run, runtime) => this.context.buildSnapshot(run, runtime),
          createRuntimeError: (message, code, status, hint, details) =>
            this.context.createRuntimeError(message, code, status, hint, details)
        });
      }
      throw this.context.createRuntimeError(`unsupported action_type '${actionType}'`, "INVALID_TRANSITION", 400);
    });
  }
}
