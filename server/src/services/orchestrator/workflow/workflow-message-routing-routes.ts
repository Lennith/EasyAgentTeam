import { hasWorkflowRoutePermission } from "./workflow-dispatch-policy.js";
import {
  appendWorkflowRouteEvents,
  buildWorkflowMessageRouteResult,
  buildWorkflowRouteEnvelope,
  resolveWorkflowRouteTarget,
  type WorkflowMessageRouteResult,
  type WorkflowMessageRoutingContext,
  type WorkflowResolvedMessageTarget,
  type WorkflowRouteMessageInput
} from "./workflow-message-routing-domain.js";
import {
  createOrchestratorMessageRoutingUnitOfWorkRunner,
  executeOrchestratorMessageRoutingInUnitOfWork
} from "../shared/index.js";
import type { WorkflowRunRecord } from "../../../domain/models.js";

export class WorkflowMessageRoutingService {
  constructor(private readonly context: WorkflowMessageRoutingContext) {}

  async routeMessage(input: WorkflowRouteMessageInput): Promise<WorkflowMessageRouteResult> {
    const run = await this.context.loadRunOrThrow(input.runId);
    const fromAgent = input.fromAgent.trim() || "manager";
    const toRole = input.toRole?.trim();
    const toSessionId = input.toSessionId?.trim();
    if (!toRole && !toSessionId) {
      throw this.context.createRuntimeError(
        "to.agent (role) or to.session_id is required",
        "MESSAGE_TARGET_REQUIRED",
        400
      );
    }
    if (toRole && !hasWorkflowRoutePermission(run, fromAgent, toRole)) {
      throw this.context.createRuntimeError("route not allowed by workflow route table", "ROUTE_DENIED", 403);
    }
    const runInUnitOfWork = createOrchestratorMessageRoutingUnitOfWorkRunner<
      WorkflowRunRecord,
      WorkflowRouteMessageInput
    >(async (scopeRun, operation) => await this.context.repositories.runInUnitOfWork({ run: scopeRun }, operation));

    return await executeOrchestratorMessageRoutingInUnitOfWork<
      WorkflowRunRecord,
      WorkflowRouteMessageInput,
      WorkflowResolvedMessageTarget,
      ReturnType<typeof buildWorkflowRouteEnvelope>,
      WorkflowMessageRouteResult
    >(run, input, runInUnitOfWork, {
      resolveTarget: async (scopeRun) =>
        await resolveWorkflowRouteTarget({
          context: this.context,
          run: scopeRun,
          toRole,
          toSessionId
        }),
      normalizeEnvelope: async (scopeRun, target) =>
        buildWorkflowRouteEnvelope({
          run: scopeRun,
          fromAgent,
          routeInput: input,
          target
        }),
      persistInbox: async (_scopeRun, target, envelope) => {
        await this.context.repositories.inbox.appendInboxMessage(input.runId, target.resolvedRole, envelope.message);
      },
      persistRouteEvent: async (_scopeRun, target, envelope) =>
        await appendWorkflowRouteEvents({
          context: this.context,
          routeInput: input,
          fromAgent,
          target,
          envelope
        }),
      touchSession: async (_scopeRun, target, envelope) => {
        await this.context.repositories.sessions.touchSession(input.runId, target.session.sessionId, {
          lastInboxMessageId: envelope.messageId
        });
      },
      buildResult: async (_scopeRun, target, envelope) =>
        buildWorkflowMessageRouteResult({
          routeInput: input,
          target,
          envelope
        })
    });
  }
}
