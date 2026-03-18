import type { RoleRuntimeState } from "../../domain/models.js";

interface SessionStateLike {
  status: string;
}

interface SessionIdleLike extends SessionStateLike {
  updatedAt: string;
}

export function resolveRoleRuntimeState(roleSessions: SessionStateLike[]): RoleRuntimeState {
  if (roleSessions.some((item) => item.status === "running")) {
    return "RUNNING";
  }
  if (roleSessions.some((item) => item.status === "idle")) {
    return "IDLE";
  }
  return "INACTIVE";
}

export function resolveLatestIdleSession<T extends SessionIdleLike>(roleSessions: T[]): T | undefined {
  return [...roleSessions]
    .filter((item) => item.status === "idle")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

export function parseIsoMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
