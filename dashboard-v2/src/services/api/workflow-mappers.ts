import type { ProviderId } from "@autodev/agent-library";
import type { AgentIOTimelineItem } from "@/types/project";
import type {
  WorkflowRunRecord,
  WorkflowRunRuntimeCounters,
  WorkflowRunRuntimeSnapshot,
  WorkflowSessionRecord,
  WorkflowTaskRuntimeRecord,
  WorkflowTaskTransitionRecord,
  WorkflowTaskTreeRuntimeNode,
  WorkflowTaskTreeRuntimeResponse
} from "@/types/workflow";

const WORKFLOW_TASK_STATES = new Set<WorkflowTaskRuntimeRecord["state"]>([
  "PLANNED",
  "READY",
  "DISPATCHED",
  "IN_PROGRESS",
  "BLOCKED_DEP",
  "DONE",
  "CANCELED"
]);

function normalizeWorkflowTaskState(state: unknown): WorkflowTaskRuntimeRecord["state"] {
  if (typeof state === "string" && WORKFLOW_TASK_STATES.has(state as WorkflowTaskRuntimeRecord["state"])) {
    return state as WorkflowTaskRuntimeRecord["state"];
  }
  return "PLANNED";
}

function normalizeWorkflowTaskTransitionRecord(transition: WorkflowTaskTransitionRecord): WorkflowTaskTransitionRecord {
  return {
    ...transition,
    fromState: transition.fromState ? normalizeWorkflowTaskState(transition.fromState) : null,
    toState: normalizeWorkflowTaskState(transition.toState)
  };
}

function normalizeWorkflowTaskRuntimeRecord(record: WorkflowTaskRuntimeRecord): WorkflowTaskRuntimeRecord {
  return {
    ...record,
    state: normalizeWorkflowTaskState(record.state),
    transitions: (record.transitions ?? []).map(normalizeWorkflowTaskTransitionRecord)
  };
}

export function normalizeWorkflowRunRuntimeCounters(counters: WorkflowRunRuntimeCounters): WorkflowRunRuntimeCounters {
  return counters;
}

export function normalizeWorkflowRunRuntimeSnapshot(snapshot: WorkflowRunRuntimeSnapshot): WorkflowRunRuntimeSnapshot {
  return {
    ...snapshot,
    counters: normalizeWorkflowRunRuntimeCounters(snapshot.counters),
    tasks: (snapshot.tasks ?? []).map(normalizeWorkflowTaskRuntimeRecord)
  };
}

function normalizeWorkflowTaskTreeRuntimeNode(node: WorkflowTaskTreeRuntimeNode): WorkflowTaskTreeRuntimeNode {
  return {
    ...node,
    runtime: node.runtime ? normalizeWorkflowTaskRuntimeRecord(node.runtime) : null
  };
}

export function normalizeWorkflowTaskTreeRuntimeResponse(
  response: WorkflowTaskTreeRuntimeResponse
): WorkflowTaskTreeRuntimeResponse {
  return {
    ...response,
    counters: normalizeWorkflowRunRuntimeCounters(response.counters),
    nodes: (response.nodes ?? []).map(normalizeWorkflowTaskTreeRuntimeNode)
  };
}

export function normalizeWorkflowRunRecord(run: WorkflowRunRecord): WorkflowRunRecord {
  return {
    ...run,
    runtime: run.runtime
      ? {
          ...run.runtime,
          tasks: (run.runtime.tasks ?? []).map(normalizeWorkflowTaskRuntimeRecord)
        }
      : run.runtime
  };
}

export function mapWorkflowSessionFields(raw: Record<string, unknown>): WorkflowSessionRecord {
  return {
    schemaVersion: (raw.schemaVersion ?? raw.schema_version ?? "1.0") as "1.0",
    sessionId: (raw.sessionId ?? raw.session_id ?? raw.sessionKey) as string,
    runId: (raw.runId ?? raw.run_id) as string,
    role: raw.role as string,
    provider: (raw.provider ?? raw.provider_id) as ProviderId,
    providerSessionId:
      (raw.providerSessionId ?? raw.provider_session_id) === null
        ? null
        : ((raw.providerSessionId ?? raw.provider_session_id) as string | undefined),
    status: raw.status as WorkflowSessionRecord["status"],
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    updatedAt: (raw.updatedAt ?? raw.updated_at) as string,
    lastActiveAt: (raw.lastActiveAt ?? raw.last_active_at) as string,
    currentTaskId: (raw.currentTaskId ?? raw.current_task_id) as string | undefined,
    lastInboxMessageId: (raw.lastInboxMessageId ?? raw.last_inbox_message_id) as string | undefined,
    lastDispatchedAt: (raw.lastDispatchedAt ?? raw.last_dispatched_at) as string | undefined,
    lastDispatchId: (raw.lastDispatchId ?? raw.last_dispatch_id) as string | undefined,
    lastDispatchedMessageId: (raw.lastDispatchedMessageId ?? raw.last_dispatched_message_id) as string | undefined
  };
}

export function mapWorkflowAgentIOTimelineItem(raw: Record<string, unknown>, runId: string): AgentIOTimelineItem {
  return {
    id: (raw.itemId ?? raw.id) as string,
    projectId: (raw.projectId ?? raw.project_id ?? "") as string,
    sessionId: (raw.sessionId ?? raw.session_id ?? raw.toSessionId ?? "") as string,
    role: (raw.role ?? raw.from ?? raw.originAgent ?? "") as string,
    taskId: (raw.taskId ?? raw.task_id) as string | undefined,
    direction: (raw.direction ?? "inbound") as "inbound" | "outbound",
    messageType: (raw.messageType ?? raw.message_type ?? raw.kind ?? "") as string,
    summary: (raw.content ?? raw.summary) as string | undefined,
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    from: raw.from as string | undefined,
    toRole: (raw.toRole ?? raw.to_role) as string | undefined,
    sourceType: raw.sourceType as "user" | "agent" | "manager" | "system" | undefined,
    originAgent: raw.originAgent as string | undefined,
    kind: raw.kind as string | undefined,
    status: raw.status as string | undefined,
    runId: (raw.runId ?? runId) as string | undefined
  };
}
