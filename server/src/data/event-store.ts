import { randomUUID } from "node:crypto";
import type { EventRecord, ProjectPaths } from "../domain/models.js";
import { appendJsonlLine, readJsonlLines } from "./store/store-runtime.js";

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

  await appendJsonlLine(paths.eventsFile, event);
  return event;
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
