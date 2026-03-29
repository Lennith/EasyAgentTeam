import type { ProjectPaths, SessionRecord } from "../../domain/models.js";
import { addSession, getSession, listSessions, touchSession } from "../session-store.js";

export type AddSessionInput = Parameters<typeof addSession>[2];
export type TouchSessionPatch = Parameters<typeof touchSession>[3];

export interface SessionRepository {
  addSession(paths: ProjectPaths, projectId: string, input: AddSessionInput): Promise<Awaited<ReturnType<typeof addSession>>>;
  getSession(paths: ProjectPaths, projectId: string, sessionId: string): Promise<SessionRecord | null>;
  listSessions(paths: ProjectPaths, projectId: string): Promise<SessionRecord[]>;
  touchSession(paths: ProjectPaths, projectId: string, sessionId: string, patch: TouchSessionPatch): Promise<SessionRecord>;
}

class DefaultSessionRepository implements SessionRepository {
  addSession(paths: ProjectPaths, projectId: string, input: AddSessionInput): Promise<Awaited<ReturnType<typeof addSession>>> {
    return addSession(paths, projectId, input);
  }

  getSession(paths: ProjectPaths, projectId: string, sessionId: string): Promise<SessionRecord | null> {
    return getSession(paths, projectId, sessionId);
  }

  listSessions(paths: ProjectPaths, projectId: string): Promise<SessionRecord[]> {
    return listSessions(paths, projectId);
  }

  touchSession(paths: ProjectPaths, projectId: string, sessionId: string, patch: TouchSessionPatch): Promise<SessionRecord> {
    return touchSession(paths, projectId, sessionId, patch);
  }
}

export function createSessionRepository(): SessionRepository {
  return new DefaultSessionRepository();
}
