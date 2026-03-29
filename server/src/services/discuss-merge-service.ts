import { randomUUID } from "node:crypto";
import type { ProjectPaths, ProjectRecord } from "../domain/models.js";
import { appendEvent } from "../data/event-store.js";
import {
  clearBufferedDiscussMessages,
  listBufferedDiscussMessages,
  type BufferedDiscussMessage
} from "../data/discuss-buffer-store.js";
import { routeProjectManagerMessage } from "./orchestrator/project-message-routing-service.js";
import { clampDiscussRounds } from "./discuss-policy-service.js";

interface MergeGroupKey {
  fromAgent: string;
  toRole: string;
  toSessionId: string;
  taskId: string;
  round: number;
}

interface MergedDiscussOutput {
  key: MergeGroupKey;
  entries: BufferedDiscussMessage[];
  mergedContent: string;
  mergedDiscuss: {
    taskId: string;
    threadId: string;
    round: number;
    discussId: string;
    maxRounds: number;
    title?: string;
  };
}

export interface DiscussMergeFlushResult {
  parentRequestId: string;
  bufferedCount: number;
  mergedCount: number;
  routedCount: number;
  routedMessageIds: string[];
}

function normalizeLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function mergeDiscussEntries(entries: BufferedDiscussMessage[]): MergedDiscussOutput {
  const first = entries[0];
  const discuss = first.discuss;
  const taskId = discuss?.taskId ?? first.taskId ?? "task-unknown";
  const round = discuss?.round ?? 1;
  const key: MergeGroupKey = {
    fromAgent: first.fromAgent,
    toRole: first.toRole ?? "unknown",
    toSessionId: first.toSessionId,
    taskId,
    round
  };

  const uniqueThreadIds = Array.from(
    new Set(entries.map((item) => item.discuss?.threadId).filter((item): item is string => Boolean(item)))
  );
  const maxRounds = Math.max(
    1,
    Math.min(
      ...entries.map((item) => {
        const raw = item.discuss?.maxRounds;
        return clampDiscussRounds(typeof raw === "number" ? raw : undefined);
      })
    )
  );
  const chosenThreadId =
    uniqueThreadIds.length === 1
      ? uniqueThreadIds[0]
      : `${taskId.replace(/[^a-zA-Z0-9._-]+/g, "-")}-merged-r${round}-${randomUUID().slice(0, 8)}`;
  const chosenDiscussId = `${chosenThreadId}-r${round}-q-merged-${randomUUID().slice(0, 6)}`;
  const title =
    entries.length > 1 ? `Merged discuss request (${entries.length} items)` : (discuss?.title ?? "Discuss request");

  const mergedContent =
    entries.length === 1
      ? first.content.trim()
      : [
          `Merged discuss request (${entries.length} items) from ${first.fromAgent} to ${first.toRole ?? "unknown"}:`,
          ...entries.map((item, index) => {
            const thread = item.discuss?.threadId ?? "thread-unknown";
            const did = item.discuss?.discussId ?? "did-unknown";
            return `${index + 1}. [thread=${thread} did=${did}] ${normalizeLine(item.content)}`;
          }),
          `Please answer all items in one consolidated discuss reply for task ${taskId}.`
        ].join("\n");

  return {
    key,
    entries,
    mergedContent,
    mergedDiscuss: {
      taskId,
      threadId: chosenThreadId,
      round,
      discussId: chosenDiscussId,
      maxRounds,
      title
    }
  };
}

function buildMergeKey(item: BufferedDiscussMessage): string {
  const round = item.discuss?.round ?? 1;
  const taskId = item.discuss?.taskId ?? item.taskId ?? "task-unknown";
  return [item.fromAgent, item.toRole ?? "unknown", item.toSessionId, taskId, String(round)].join("|");
}

export async function flushMergedDiscussRequestsForParent(
  dataRoot: string,
  project: ProjectRecord,
  paths: ProjectPaths,
  parentRequestId: string
): Promise<DiscussMergeFlushResult> {
  const resolvedParentRequestId = parentRequestId.trim();
  if (!resolvedParentRequestId) {
    return {
      parentRequestId: "",
      bufferedCount: 0,
      mergedCount: 0,
      routedCount: 0,
      routedMessageIds: []
    };
  }

  const buffered = await listBufferedDiscussMessages(paths, resolvedParentRequestId);
  if (buffered.length === 0) {
    return {
      parentRequestId: resolvedParentRequestId,
      bufferedCount: 0,
      mergedCount: 0,
      routedCount: 0,
      routedMessageIds: []
    };
  }

  const groups = new Map<string, BufferedDiscussMessage[]>();
  for (const item of buffered) {
    const key = buildMergeKey(item);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(item);
  }

  const mergedRows = Array.from(groups.values()).map((rows) => mergeDiscussEntries(rows));
  const routedMessageIds: string[] = [];
  for (const row of mergedRows) {
    const createdAt = new Date().toISOString();
    const messageId = randomUUID();
    const requestId = randomUUID();
    const routed = await routeProjectManagerMessage({
      dataRoot,
      project,
      paths,
      fromAgent: row.key.fromAgent,
      fromSessionId: "manager-system",
      messageType: "TASK_DISCUSS_REQUEST",
      toRole: row.key.toRole,
      toSessionId: row.key.toSessionId,
      requestId,
      parentRequestId: resolvedParentRequestId,
      taskId: row.key.taskId,
      content: row.mergedContent,
      discuss: row.mergedDiscuss,
      messageId,
      createdAt
    });
    routedMessageIds.push(routed.messageId);
  }

  await appendEvent(paths, {
    projectId: project.projectId,
    eventType: "DISCUSS_BUFFER_FLUSHED",
    source: "manager",
    payload: {
      parentRequestId: resolvedParentRequestId,
      bufferedCount: buffered.length,
      mergedCount: mergedRows.length,
      routedCount: routedMessageIds.length
    }
  });

  await clearBufferedDiscussMessages(paths, resolvedParentRequestId);
  return {
    parentRequestId: resolvedParentRequestId,
    bufferedCount: buffered.length,
    mergedCount: mergedRows.length,
    routedCount: routedMessageIds.length,
    routedMessageIds
  };
}
