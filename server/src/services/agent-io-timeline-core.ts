export interface AgentTimelineItem {
  itemId: string;
  kind:
    | "user_message"
    | "message_routed"
    | "task_action"
    | "task_discuss"
    | "task_report"
    | "dispatch_started"
    | "dispatch_finished"
    | "dispatch_failed";
  createdAt: string;
  from?: string;
  toRole?: string | null;
  toSessionId?: string | null;
  requestId?: string | null;
  messageId?: string | null;
  runId?: string | null;
  status?: string | null;
  content?: string;
  messageType?: string | null;
  discussThreadId?: string | null;
  sourceType?: "user" | "agent" | "manager" | "system" | null;
  originAgent?: string | null;
  relaySource?: string | null;
  mergedFromBuffered?: boolean;
  mergedCount?: number | null;
  sourceRequestIds?: string[] | null;
}

export interface AgentTimelineEventLike {
  eventId: string;
  eventType: string;
  createdAt: string;
  payload: unknown;
}

export interface BuildAgentTimelineOptions {
  limit?: number;
  includeRequestedSkillIds?: boolean;
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPayloadBool(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === "boolean" ? value : undefined;
}

function readPayloadNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPayloadStringArray(payload: Record<string, unknown>, key: string): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function readDiscussThreadId(payload: Record<string, unknown>): string | null {
  const discussRaw =
    typeof payload.discuss === "object" && payload.discuss !== null
      ? (payload.discuss as Record<string, unknown>)
      : null;
  if (!discussRaw) {
    return null;
  }
  const thread =
    (typeof discussRaw.threadId === "string" ? discussRaw.threadId : undefined) ??
    (typeof discussRaw.thread_id === "string" ? discussRaw.thread_id : undefined);
  if (!thread) {
    return null;
  }
  const trimmed = thread.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function computeSenderFrom(payload: Record<string, unknown>): string {
  const sourceType = readPayloadString(payload, "sourceType") as "user" | "agent" | "manager" | "system" | undefined;
  const originAgent = readPayloadString(payload, "originAgent") ?? readPayloadString(payload, "fromAgent");
  const fromAgent = readPayloadString(payload, "fromAgent");

  if (sourceType === "user") {
    return "User";
  }
  if (sourceType === "agent" && originAgent) {
    return originAgent;
  }
  if (sourceType === "system") {
    return "System";
  }
  if (sourceType === "manager") {
    if (originAgent && originAgent !== "manager") {
      return originAgent;
    }
    if (fromAgent && fromAgent !== "manager") {
      return fromAgent;
    }
    return "Manager";
  }
  if (originAgent) {
    return originAgent;
  }
  if (fromAgent) {
    return fromAgent;
  }
  return "Manager";
}

function buildRequestedSkillIdsContent(payload: Record<string, unknown>, prefix?: string): string | undefined {
  const requestedSkillIds = readPayloadStringArray(payload, "requestedSkillIds") ?? [];
  if (requestedSkillIds.length === 0) {
    return prefix;
  }
  const skills = `requestedSkillIds=${requestedSkillIds.join(",")}`;
  return prefix ? `${prefix} | ${skills}` : skills;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return undefined;
  }
  return Math.max(1, Math.floor(limit));
}

export function buildAgentTimelineFromEvents(
  events: AgentTimelineEventLike[],
  options: BuildAgentTimelineOptions = {}
): { items: AgentTimelineItem[]; total: number } {
  const items: AgentTimelineItem[] = [];
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.eventType === "USER_MESSAGE_RECEIVED") {
      items.push({
        itemId: event.eventId,
        kind: "user_message",
        createdAt: event.createdAt,
        from: computeSenderFrom(payload),
        toRole: (payload.toRole as string | null | undefined) ?? null,
        requestId: (payload.requestId as string | null | undefined) ?? null,
        content: String(payload.content ?? ""),
        sourceType:
          (readPayloadString(payload, "sourceType") as "user" | "agent" | "manager" | "system" | undefined) ?? null,
        originAgent: readPayloadString(payload, "originAgent") ?? readPayloadString(payload, "fromAgent") ?? null,
        relaySource: readPayloadString(payload, "relaySource") ?? null,
        mergedFromBuffered: readPayloadBool(payload, "mergedFromBuffered"),
        mergedCount: readPayloadNumber(payload, "mergedCount") ?? null,
        sourceRequestIds: readPayloadStringArray(payload, "sourceRequestIds") ?? null
      });
      continue;
    }

    if (event.eventType === "MESSAGE_ROUTED") {
      const messageType = (payload.messageType as string | undefined) ?? null;
      items.push({
        itemId: event.eventId,
        kind: messageType && messageType.startsWith("TASK_DISCUSS") ? "task_discuss" : "message_routed",
        createdAt: event.createdAt,
        from: computeSenderFrom(payload),
        toRole: (payload.toRole as string | null | undefined) ?? null,
        toSessionId: (payload.resolvedSessionId as string | null | undefined) ?? null,
        requestId: (payload.requestId as string | null | undefined) ?? null,
        messageId: (payload.messageId as string | null | undefined) ?? null,
        content: readPayloadString(payload, "content") ?? "",
        messageType,
        discussThreadId: readDiscussThreadId(payload),
        sourceType:
          (readPayloadString(payload, "sourceType") as "user" | "agent" | "manager" | "system" | undefined) ?? null,
        originAgent: readPayloadString(payload, "originAgent") ?? null,
        relaySource: readPayloadString(payload, "relaySource") ?? null,
        mergedFromBuffered: readPayloadBool(payload, "mergedFromBuffered"),
        mergedCount: readPayloadNumber(payload, "mergedCount") ?? null,
        sourceRequestIds: readPayloadStringArray(payload, "sourceRequestIds") ?? null
      });
      continue;
    }

    if (event.eventType === "TASK_ACTION_RECEIVED") {
      const actionType = (payload.actionType as string | null | undefined) ?? null;
      items.push({
        itemId: event.eventId,
        kind: "task_action",
        createdAt: event.createdAt,
        from: readPayloadString(payload, "fromAgent") ?? "manager",
        toRole: (payload.toRole as string | null | undefined) ?? (actionType === "TASK_REPORT" ? "manager" : null),
        toSessionId: (payload.toSessionId as string | null | undefined) ?? null,
        requestId: (payload.requestId as string | null | undefined) ?? null,
        messageType: actionType
      });
      continue;
    }

    if (event.eventType === "TASK_ACTION_REJECTED") {
      const actionType = (payload.actionType as string | null | undefined) ?? null;
      const reason = readPayloadString(payload, "reason") ?? "task action rejected";
      const nextAction = readPayloadString(payload, "next_action");
      items.push({
        itemId: event.eventId,
        kind: "task_action",
        createdAt: event.createdAt,
        from: readPayloadString(payload, "fromAgent") ?? "manager",
        toRole: (payload.toRole as string | null | undefined) ?? (actionType === "TASK_REPORT" ? "manager" : null),
        toSessionId: (payload.toSessionId as string | null | undefined) ?? null,
        requestId: (payload.requestId as string | null | undefined) ?? null,
        messageType: actionType,
        status: readPayloadString(payload, "error_code") ?? "TASK_ACTION_REJECTED",
        content: nextAction ? `${reason} | next_action: ${nextAction}` : reason
      });
      continue;
    }

    if (event.eventType === "TASK_REPORT_APPLIED") {
      const applied = Array.isArray(payload.appliedTaskIds) ? payload.appliedTaskIds.map((value) => String(value)) : [];
      const updated = Array.isArray(payload.updatedTaskIds) ? payload.updatedTaskIds.map((value) => String(value)) : [];
      const rejectedCount = Number(payload.rejectedCount ?? 0);
      items.push({
        itemId: event.eventId,
        kind: "task_report",
        createdAt: event.createdAt,
        from: readPayloadString(payload, "fromAgent") ?? "agent",
        toRole: (payload.toRole as string | null | undefined) ?? "manager",
        requestId: (payload.requestId as string | null | undefined) ?? null,
        messageType: "TASK_REPORT",
        content: `applied: ${applied.length} | updated: ${updated.length} | rejected: ${Number.isFinite(rejectedCount) ? rejectedCount : 0}`
      });
      continue;
    }

    if (event.eventType === "ORCHESTRATOR_DISPATCH_STARTED") {
      items.push({
        itemId: event.eventId,
        kind: "dispatch_started",
        createdAt: event.createdAt,
        requestId: (payload.requestId as string | null | undefined) ?? null,
        messageId: (payload.messageId as string | null | undefined) ?? null,
        status: "running",
        content: options.includeRequestedSkillIds ? buildRequestedSkillIdsContent(payload) : undefined
      });
      continue;
    }

    if (event.eventType === "ORCHESTRATOR_DISPATCH_FAILED") {
      const error = String(payload.error ?? "dispatch_failed");
      items.push({
        itemId: event.eventId,
        kind: "dispatch_failed",
        createdAt: event.createdAt,
        requestId: (payload.requestId as string | null | undefined) ?? null,
        messageId: (payload.messageId as string | null | undefined) ?? null,
        status: error,
        content: options.includeRequestedSkillIds ? buildRequestedSkillIdsContent(payload, error) : undefined
      });
      continue;
    }

    if (event.eventType === "ORCHESTRATOR_DISPATCH_FINISHED") {
      items.push({
        itemId: event.eventId,
        kind: "dispatch_finished",
        createdAt: event.createdAt,
        requestId: (payload.requestId as string | null | undefined) ?? null,
        messageId: (payload.messageId as string | null | undefined) ?? null,
        runId: (payload.runId as string | null | undefined) ?? null,
        status: (payload.timedOut as boolean | undefined) ? "timed_out" : "done",
        content: options.includeRequestedSkillIds ? buildRequestedSkillIdsContent(payload) : undefined
      });
    }
  }

  items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const limit = normalizeLimit(options.limit);
  const sliced = typeof limit === "number" ? items.slice(-limit) : items;
  return {
    items: sliced,
    total: items.length
  };
}
