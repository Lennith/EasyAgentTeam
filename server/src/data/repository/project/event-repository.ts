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
import {
  appendRecoveryAttemptEventToArchive,
  getRecoveryAttemptArchiveFile,
  readRecoveryAttemptArchiveEvents
} from "../../../services/runtime-recovery-attempt-archive.js";
import { isRecoveryAttemptEventType, isRecoverySidecarRelevantEventType } from "../../../services/runtime-recovery-attempts.js";

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
  if (!isRecoverySidecarRelevantEventType(event.eventType)) {
    await runStorageTransaction([paths.eventsFile], async () => {
      await appendJsonlLine(paths.eventsFile, event);
    });
    return event;
  }

  const transactionPaths = [paths.eventsFile, indexScope.index_file];
  if (event.sessionId && isRecoveryAttemptEventType(event.eventType)) {
    transactionPaths.push(getRecoveryAttemptArchiveFile(indexScope, event.sessionId));
  }
  await runStorageTransaction(transactionPaths, async () => {
    await appendJsonlLine(paths.eventsFile, event);
    await appendRecoveryEventToIndex(indexScope, event);
    await appendRecoveryAttemptEventToArchive(indexScope, event);
  });
  return event;
}

export function getProjectRecoveryEventIndexFile(paths: ProjectPaths): string {
  return path.join(path.dirname(paths.sessionsFile), "recovery-event-index.json");
}

export function getProjectRecoveryAttemptArchiveDir(paths: ProjectPaths): string {
  return path.join(path.dirname(paths.sessionsFile), "recovery-attempt-archive");
}

export function buildProjectRecoveryEventIndexScope(paths: ProjectPaths, projectId: string) {
  return {
    scope_kind: "project" as const,
    scope_id: projectId,
    index_file: getProjectRecoveryEventIndexFile(paths),
    events_file: paths.eventsFile,
    attempt_archive_dir: getProjectRecoveryAttemptArchiveDir(paths)
  };
}

export async function getRecoveryEventIndex(
  paths: ProjectPaths,
  projectId: string
): Promise<RecoveryEventIndexState> {
  return readRecoveryEventIndex(buildProjectRecoveryEventIndexScope(paths, projectId));
}

export async function getRecoveryAttemptArchiveEvents(
  paths: ProjectPaths,
  projectId: string,
  sessionId: string
): Promise<EventRecord[]> {
  return readRecoveryAttemptArchiveEvents(buildProjectRecoveryEventIndexScope(paths, projectId), sessionId) as Promise<
    EventRecord[]
  >;
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
  getRecoveryAttemptArchiveEvents(paths: ProjectPaths, projectId: string, sessionId: string): Promise<EventRecord[]>;
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

  getRecoveryAttemptArchiveEvents(paths: ProjectPaths, projectId: string, sessionId: string): Promise<EventRecord[]> {
    return getRecoveryAttemptArchiveEvents(paths, projectId, sessionId);
  }
}

export function createEventRepository(): EventRepository {
  return new DefaultEventRepository();
}
