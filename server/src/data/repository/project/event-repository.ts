import path from "node:path";
import { randomUUID } from "node:crypto";
import type { EventRecord, ProjectPaths } from "../../../domain/models.js";
import { appendJsonlLine, readJsonlLines } from "../../internal/persistence/store/store-runtime.js";
import { runStorageTransaction } from "../../internal/persistence/file-utils.js";
import {
  appendRecoveryEventToIndex,
  readRecoveryEventIndex,
  type RecoveryEventIndexState
} from "../../../services/runtime-recovery-event-index.js";

interface AppendEventInput {
  projectId: string;
  eventType: string;
  source: EventRecord["source"];
  payload: Record<string, unknown>;
  sessionId?: string;
  taskId?: string;
}

export async function appendEvent(
  paths: ProjectPaths,
  input: AppendEventInput
): Promise<EventRecord> {
  const event: EventRecord = {
    schemaVersion: "1.0",
    eventId: randomUUID(),
    projectId: input.projectId,
    eventType: input.eventType,
    source: input.source,
    createdAt: new Date().toISOString(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    payload: input.payload
  };

  const indexScope = buildProjectRecoveryEventIndexScope(paths, input.projectId);
  await runStorageTransaction([paths.eventsFile, indexScope.index_file], async () => {
    await appendJsonlLine(paths.eventsFile, event);
    await appendRecoveryEventToIndex(indexScope, event);
  });
  return event;
}

export function getProjectRecoveryEventIndexFile(paths: ProjectPaths): string {
  return path.join(path.dirname(paths.sessionsFile), "recovery-event-index.json");
}

export function buildProjectRecoveryEventIndexScope(paths: ProjectPaths, projectId: string) {
  return {
    scope_kind: "project" as const,
    scope_id: projectId,
    index_file: getProjectRecoveryEventIndexFile(paths),
    events_file: paths.eventsFile
  };
}

export async function getRecoveryEventIndex(
  paths: ProjectPaths,
  projectId: string
): Promise<RecoveryEventIndexState> {
  return readRecoveryEventIndex(buildProjectRecoveryEventIndexScope(paths, projectId));
}

export async function listEvents(paths: ProjectPaths, since?: string): Promise<EventRecord[]> {
  const all = await readJsonlLines<EventRecord>(paths.eventsFile);
  if (!since) {
    return all;
  }

  const sinceTs = Date.parse(since);
  if (Number.isNaN(sinceTs)) {
    return all;
  }

  return all.filter((event) => Date.parse(event.createdAt) > sinceTs);
}

export function eventsToNdjson(events: EventRecord[]): string {
  if (events.length === 0) {
    return "";
  }
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export interface EventRepository {
  appendEvent(paths: ProjectPaths, input: AppendEventInput): Promise<EventRecord>;
  listEvents(paths: ProjectPaths, since?: string): Promise<EventRecord[]>;
  getRecoveryEventIndex(paths: ProjectPaths, projectId: string): Promise<RecoveryEventIndexState>;
}

class DefaultEventRepository implements EventRepository {
  appendEvent(paths: ProjectPaths, input: AppendEventInput): Promise<EventRecord> {
    return appendEvent(paths, input);
  }

  listEvents(paths: ProjectPaths, since?: string): Promise<EventRecord[]> {
    return listEvents(paths, since);
  }

  getRecoveryEventIndex(paths: ProjectPaths, projectId: string): Promise<RecoveryEventIndexState> {
    return getRecoveryEventIndex(paths, projectId);
  }
}

export function createEventRepository(): EventRepository {
  return new DefaultEventRepository();
}
