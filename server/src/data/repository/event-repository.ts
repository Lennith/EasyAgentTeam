import type { EventRecord, ProjectPaths } from "../../domain/models.js";
import { appendEvent, listEvents } from "../event-store.js";

export type AppendEventInput = Parameters<typeof appendEvent>[1];

export interface EventRepository {
  appendEvent(paths: ProjectPaths, input: AppendEventInput): Promise<EventRecord>;
  listEvents(paths: ProjectPaths, since?: string): Promise<EventRecord[]>;
}

class DefaultEventRepository implements EventRepository {
  appendEvent(paths: ProjectPaths, input: AppendEventInput): Promise<EventRecord> {
    return appendEvent(paths, input);
  }

  listEvents(paths: ProjectPaths, since?: string): Promise<EventRecord[]> {
    return listEvents(paths, since);
  }
}

export function createEventRepository(): EventRepository {
  return new DefaultEventRepository();
}
