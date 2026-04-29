import type {
  AgentIOTimelineItem,
  EventRecord,
  SessionRecord,
  TaskDetail,
  TaskTreeNode,
  TaskTreeResponse
} from "@/types/project";

const TASK_STATES = new Set<TaskTreeNode["state"]>([
  "PLANNED",
  "READY",
  "DISPATCHED",
  "IN_PROGRESS",
  "BLOCKED_DEP",
  "DONE",
  "CANCELED"
]);

function normalizeTaskState(state: unknown): TaskTreeNode["state"] {
  if (typeof state === "string" && TASK_STATES.has(state as TaskTreeNode["state"])) {
    return state as TaskTreeNode["state"];
  }
  return "PLANNED";
}

export function normalizeTaskTreeNode(node: TaskTreeNode): TaskTreeNode {
  return {
    ...node,
    state: normalizeTaskState(node.state)
  };
}

export function normalizeTaskTreeResponse(response: TaskTreeResponse): TaskTreeResponse {
  return {
    ...response,
    focus: response.focus ? normalizeTaskTreeNode(response.focus) : null,
    nodes: (response.nodes ?? []).map(normalizeTaskTreeNode)
  };
}

export function normalizeTaskDetail(detail: TaskDetail): TaskDetail {
  return {
    ...detail,
    task: normalizeTaskTreeNode(detail.task)
  };
}

export function mapSessionFields(raw: Record<string, unknown>): SessionRecord {
  return {
    sessionId: (raw.sessionId ?? raw.session_id ?? raw.sessionKey) as string,
    projectId: (raw.projectId ?? raw.project_id) as string,
    role: raw.role as string,
    status: raw.status as SessionRecord["status"],
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    updatedAt: (raw.updatedAt ?? raw.updated_at) as string,
    currentTaskId: (raw.currentTaskId ?? raw.current_task_id) as string | undefined,
    lastHeartbeat: (raw.lastActiveAt ?? raw.last_heartbeat ?? raw.lastHeartbeat) as string | undefined,
    lastActiveAt: (raw.lastActiveAt ?? raw.last_active_at) as string | undefined,
    lastDispatchedAt: (raw.lastDispatchedAt ?? raw.last_dispatched_at) as string | undefined,
    agentTool: raw.agentTool as string | undefined,
    sessionKey: raw.sessionKey as string | undefined,
    providerSessionId: raw.providerSessionId as string | null | undefined,
    provider: raw.provider as string | undefined,
    locksHeldCount: raw.locksHeldCount as number | undefined
  };
}

export function mapEventFields(raw: Record<string, unknown>): EventRecord {
  return {
    eventId: (raw.eventId ?? raw.event_id) as string,
    eventType: (raw.eventType ?? raw.event_type) as string,
    source: raw.source as string,
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    sessionId: (raw.sessionId ?? raw.session_id) as string | undefined,
    payload: (raw.payload ?? {}) as Record<string, unknown>
  };
}

export function mapProjectAgentIOTimelineItem(raw: Record<string, unknown>): AgentIOTimelineItem {
  return {
    id: (raw.itemId ?? raw.id ?? raw.ioId) as string,
    projectId: (raw.projectId ?? raw.project_id) as string,
    sessionId: (raw.sessionId ?? raw.session_id ?? raw.toSessionId) as string,
    role: (raw.role ?? raw.from ?? raw.toRole) as string,
    taskId: (raw.taskId ?? raw.task_id) as string | undefined,
    direction: (raw.direction ?? (raw.kind?.toString().includes("report") ? "outbound" : "inbound")) as
      | "inbound"
      | "outbound",
    messageType: (raw.messageType ?? raw.kind ?? raw.message_type) as string,
    summary: (raw.content ?? raw.summary) as string | undefined,
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    from: raw.from as string | undefined,
    toRole: raw.toRole as string | undefined,
    sourceType: raw.sourceType as "user" | "agent" | "manager" | "system" | undefined,
    originAgent: raw.originAgent as string | undefined,
    kind: raw.kind as string | undefined,
    status: raw.status as string | undefined,
    runId: raw.runId as string | undefined
  };
}
