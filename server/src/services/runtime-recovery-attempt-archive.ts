import fs from "node:fs/promises";
import path from "node:path";
import type { RecoveryStatus } from "./runtime-recovery-action-policy.js";
import {
  buildSessionRecoveryAttempts,
  compareRecoveryEventsAsc,
  isRecoveryAttemptEventType,
  readRecoveryAttemptId,
  type RecoveryAttemptLimit,
  type RuntimeRecoveryAttempt
} from "./runtime-recovery-attempts.js";
import type { RecoveryEventIndexScope, RecoveryIndexableEvent } from "./runtime-recovery-event-index.js";
import { appendJsonlLine, readJsonlLines, writeJsonlLines } from "../data/internal/persistence/store/store-runtime.js";
import { ensureDirectory } from "../data/internal/persistence/file-utils.js";

function encodeSessionArchiveName(sessionId: string): string {
  return `${encodeURIComponent(sessionId)}.jsonl`;
}

export function getRecoveryAttemptArchiveFile(scope: RecoveryEventIndexScope, sessionId: string): string {
  return path.join(scope.attempt_archive_dir, encodeSessionArchiveName(sessionId));
}

function isArchivedAttemptEvent(event: RecoveryIndexableEvent, sessionId: string): boolean {
  return (
    event.sessionId === sessionId &&
    isRecoveryAttemptEventType(event.eventType) &&
    Boolean(readRecoveryAttemptId(event.payload))
  );
}

async function rebuildRecoveryAttemptArchive(
  scope: RecoveryEventIndexScope,
  sessionId: string
): Promise<RecoveryIndexableEvent[]> {
  const archiveFile = getRecoveryAttemptArchiveFile(scope, sessionId);
  const events = (await readJsonlLines<RecoveryIndexableEvent>(scope.events_file))
    .filter((event) => isArchivedAttemptEvent(event, sessionId))
    .sort(compareRecoveryEventsAsc);
  await ensureDirectory(scope.attempt_archive_dir);
  await writeJsonlLines(archiveFile, events);
  return events;
}

export async function appendRecoveryAttemptEventToArchive(
  scope: RecoveryEventIndexScope,
  event: RecoveryIndexableEvent
): Promise<void> {
  if (!event.sessionId || !isArchivedAttemptEvent(event, event.sessionId)) {
    return;
  }
  await ensureDirectory(scope.attempt_archive_dir);
  await appendJsonlLine(getRecoveryAttemptArchiveFile(scope, event.sessionId), event);
}

export async function readRecoveryAttemptArchiveEvents(
  scope: RecoveryEventIndexScope,
  sessionId: string
): Promise<RecoveryIndexableEvent[]> {
  const archiveFile = getRecoveryAttemptArchiveFile(scope, sessionId);
  try {
    await fs.access(archiveFile);
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      return rebuildRecoveryAttemptArchive(scope, sessionId);
    }
    throw error;
  }

  try {
    const events = await readJsonlLines<RecoveryIndexableEvent>(archiveFile);
    if (events.every((event) => isArchivedAttemptEvent(event, sessionId))) {
      return events.sort(compareRecoveryEventsAsc);
    }
  } catch {
    // Corrupt attempt archives are repairable from the append-only event log.
  }
  return rebuildRecoveryAttemptArchive(scope, sessionId);
}

export async function readSessionRecoveryAttemptsFromArchive(
  scope: RecoveryEventIndexScope,
  sessionId: string,
  sessionStatus: RecoveryStatus,
  options: { attempt_limit?: RecoveryAttemptLimit } = {}
): Promise<{ attempts: RuntimeRecoveryAttempt[]; total: number; truncated: boolean }> {
  const events = await readRecoveryAttemptArchiveEvents(scope, sessionId);
  return buildSessionRecoveryAttempts(events, sessionId, sessionStatus, options);
}
