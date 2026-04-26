interface DispatchEventLike {
  eventType: string;
  createdAt: string;
  payload: unknown;
  taskId?: string;
  sessionId?: string;
}

export interface OpenTaskDispatchLike<T extends DispatchEventLike = DispatchEventLike> {
  event: T;
  dispatchId: string;
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
  return findLatestOpenTaskDispatch(events, taskId, sessionId) !== null;
}

export function findLatestOpenTaskDispatch<T extends DispatchEventLike>(
  events: T[],
  taskId: string,
  sessionId: string
): OpenTaskDispatchLike<T> | null {
  const started = new Set<string>();
  const startedEvents = new Map<string, T>();
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
      startedEvents.set(dispatchId, event);
      continue;
    }
    if (event.eventType === "ORCHESTRATOR_DISPATCH_FINISHED" || event.eventType === "ORCHESTRATOR_DISPATCH_FAILED") {
      started.delete(dispatchId);
      startedEvents.delete(dispatchId);
    }
  }
  if (started.size === 0) {
    return null;
  }
  const latest = [...started]
    .map((dispatchId) => ({ dispatchId, event: startedEvents.get(dispatchId) }))
    .filter((item): item is { dispatchId: string; event: T } => Boolean(item.event))
    .sort((a, b) => Date.parse(b.event.createdAt) - Date.parse(a.event.createdAt))[0];
  if (!latest) {
    return null;
  }
  return latest;
}
