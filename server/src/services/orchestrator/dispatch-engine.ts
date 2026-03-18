interface DispatchEventLike {
  eventType: string;
  createdAt: string;
  payload: unknown;
  taskId?: string;
  sessionId?: string;
}

export function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function findLatestOpenDispatch<T extends DispatchEventLike>(
  sessionEvents: T[]
): { event: T; dispatchId: string } | null {
  const started = new Map<string, T>();
  for (const event of sessionEvents) {
    const payload = event.payload as Record<string, unknown>;
    const dispatchId = readPayloadString(payload, "dispatchId");
    if (!dispatchId) {
      continue;
    }
    if (event.eventType === "ORCHESTRATOR_DISPATCH_STARTED") {
      started.set(dispatchId, event);
      continue;
    }
    if (event.eventType === "ORCHESTRATOR_DISPATCH_FINISHED" || event.eventType === "ORCHESTRATOR_DISPATCH_FAILED") {
      started.delete(dispatchId);
    }
  }
  if (started.size === 0) {
    return null;
  }
  const latest = [...started.entries()].sort((a, b) => Date.parse(b[1].createdAt) - Date.parse(a[1].createdAt))[0];
  return {
    dispatchId: latest[0],
    event: latest[1]
  };
}

export function hasOpenTaskDispatch<T extends DispatchEventLike>(
  events: T[],
  taskId: string,
  sessionId: string
): boolean {
  const started = new Set<string>();
  for (const event of events) {
    if (event.taskId !== taskId || event.sessionId !== sessionId) {
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    const dispatchId = readPayloadString(payload, "dispatchId");
    const dispatchKind = readPayloadString(payload, "dispatchKind");
    if (!dispatchId || dispatchKind !== "task") {
      continue;
    }
    if (event.eventType === "ORCHESTRATOR_DISPATCH_STARTED") {
      started.add(dispatchId);
      continue;
    }
    if (event.eventType === "ORCHESTRATOR_DISPATCH_FINISHED" || event.eventType === "ORCHESTRATOR_DISPATCH_FAILED") {
      started.delete(dispatchId);
    }
  }
  return started.size > 0;
}
