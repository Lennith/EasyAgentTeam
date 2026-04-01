import { randomUUID } from "node:crypto";

function compactRandomToken(length: number): string {
  return randomUUID().replace(/-/g, "").slice(0, length);
}

export function sanitizeOrchestratorRoleToken(role: string): string {
  return role.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

export function buildRoleScopedSessionId(role: string): string {
  return `session-${sanitizeOrchestratorRoleToken(role)}-${compactRandomToken(12)}`;
}

export function createTimestampRequestId(): string {
  return `${Date.now()}`;
}

export function createOpaqueIdentifier(): string {
  return randomUUID();
}

export function createTimestampedIdentifier(prefix = "", tokenLength = 8): string {
  return `${prefix}${Date.now()}-${compactRandomToken(tokenLength)}`;
}
