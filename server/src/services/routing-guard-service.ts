import type { ProjectPaths } from "../domain/models.js";
import { getSession } from "../data/session-store.js";

export const RESERVED_TARGET_SESSION_IDS = new Set(["dashboard-ui", "manager-system"]);

export type RoutingRejectCode =
  | "invalid_target_session_reserved"
  | "target_session_not_found"
  | "target_session_role_mismatch";

export interface RoutingRejectError {
  code: RoutingRejectCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ExplicitTargetSessionValidation {
  ok: true;
  sessionId: string;
  resolvedRole: string;
}

export interface ExplicitTargetSessionValidationFailed {
  ok: false;
  error: RoutingRejectError;
}

export type ExplicitTargetSessionValidationResult =
  | ExplicitTargetSessionValidation
  | ExplicitTargetSessionValidationFailed;

function normalizeOptional(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isReservedTargetSessionId(sessionId: string | undefined | null): boolean {
  const normalized = normalizeOptional(sessionId);
  if (!normalized) {
    return false;
  }
  return RESERVED_TARGET_SESSION_IDS.has(normalized);
}

export async function validateExplicitTargetSession(
  paths: ProjectPaths,
  projectId: string,
  requestedSessionId: string | undefined | null,
  expectedRole?: string
): Promise<ExplicitTargetSessionValidationResult> {
  const normalizedSessionId = normalizeOptional(requestedSessionId);
  if (!normalizedSessionId) {
    return {
      ok: false,
      error: {
        code: "target_session_not_found",
        message: "target session id is empty"
      }
    };
  }

  if (isReservedTargetSessionId(normalizedSessionId)) {
    return {
      ok: false,
      error: {
        code: "invalid_target_session_reserved",
        message: `target session '${normalizedSessionId}' is reserved for system/dashboard`,
        details: { sessionId: normalizedSessionId }
      }
    };
  }

  const target = await getSession(paths, projectId, normalizedSessionId);
  if (!target) {
    return {
      ok: false,
      error: {
        code: "target_session_not_found",
        message: `target session '${normalizedSessionId}' not found`,
        details: { sessionId: normalizedSessionId }
      }
    };
  }

  const normalizedExpectedRole = normalizeOptional(expectedRole);
  if (normalizedExpectedRole && target.role !== normalizedExpectedRole) {
    return {
      ok: false,
      error: {
        code: "target_session_role_mismatch",
        message: `target session role mismatch (expected=${normalizedExpectedRole}, actual=${target.role})`,
        details: {
          sessionId: normalizedSessionId,
          expectedRole: normalizedExpectedRole,
          actualRole: target.role
        }
      }
    };
  }

  return {
    ok: true,
    sessionId: target.sessionId,
    resolvedRole: target.role
  };
}

export function validateRoleSessionMapWrite(
  role: string | undefined,
  sessionId: string | undefined
): RoutingRejectError | null {
  const normalizedRole = normalizeOptional(role);
  const normalizedSessionId = normalizeOptional(sessionId);
  if (!normalizedRole || !normalizedSessionId) {
    return null;
  }
  if (isReservedTargetSessionId(normalizedSessionId)) {
    return {
      code: "invalid_target_session_reserved",
      message: `roleSessionMap write rejected: role=${normalizedRole} cannot point to reserved session '${normalizedSessionId}'`,
      details: {
        role: normalizedRole,
        sessionId: normalizedSessionId
      }
    };
  }
  return null;
}
