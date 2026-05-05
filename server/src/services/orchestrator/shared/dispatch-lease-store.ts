import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectPaths } from "../../../domain/models.js";
import type { Repository } from "../../../data/repository/shared/types.js";
import { getWorkflowRunRuntimePaths } from "../../../data/repository/workflow/runtime-repository.js";
import { readPayloadString } from "./dispatch-engine.js";

export const DISPATCH_LEASE_SCHEMA_VERSION = "1.0";
export const DEFAULT_DISPATCH_LEASE_TTL_MS = 10 * 60 * 1000;

export type DispatchLeaseScopeKind = "project" | "workflow";
export type DispatchLeaseStatus = "open" | "closing" | "retrying" | "cooldown" | "closed";
export type DispatchLeaseDispatchKind = "task" | "message" | null;

export interface DispatchLeaseRecord {
  dispatch_id: string;
  scope_kind: DispatchLeaseScopeKind;
  scope_id: string;
  session_id: string;
  role: string;
  dispatch_kind: DispatchLeaseDispatchKind;
  task_id?: string | null;
  message_id?: string | null;
  status: DispatchLeaseStatus;
  created_at: string;
  updated_at: string;
  expires_at: string;
  heartbeat_at: string;
  recovery_attempt_id?: string | null;
}

export interface DispatchLeaseIndex {
  schemaVersion: typeof DISPATCH_LEASE_SCHEMA_VERSION;
  updatedAt: string;
  leases: DispatchLeaseRecord[];
}

export interface DispatchLeaseEventLike {
  eventType: string;
  createdAt: string;
  payload: unknown;
  sessionId?: string;
  taskId?: string;
}

export interface UpsertDispatchLeaseInput {
  dispatchId: string;
  scopeKind: DispatchLeaseScopeKind;
  scopeId: string;
  sessionId: string;
  role: string;
  dispatchKind: DispatchLeaseDispatchKind;
  taskId?: string | null;
  messageId?: string | null;
  status?: DispatchLeaseStatus;
  recoveryAttemptId?: string | null;
}

export interface ReserveDispatchLeaseResult {
  reserved: boolean;
  activeCount: number;
  maxActive: number;
  lease?: DispatchLeaseRecord;
}

export interface DispatchLeaseMatchInput {
  scopeKind: DispatchLeaseScopeKind;
  scopeId: string;
  sessionId: string;
  taskId?: string | null;
  messageId?: string | null;
  now?: Date;
}

export function getProjectDispatchLeaseFile(paths: Pick<ProjectPaths, "sessionsFile">): string {
  return path.join(path.dirname(paths.sessionsFile), "dispatch-leases.json");
}

export function tryGetProjectDispatchLeaseFile(paths: Partial<Pick<ProjectPaths, "sessionsFile">>): string | null {
  return typeof paths.sessionsFile === "string" && paths.sessionsFile.trim().length > 0
    ? getProjectDispatchLeaseFile(paths as Pick<ProjectPaths, "sessionsFile">)
    : null;
}

export function getWorkflowDispatchLeaseFile(dataRoot: string, runId: string): string {
  return path.join(getWorkflowRunRuntimePaths(dataRoot, runId).runRootDir, "dispatch-leases.json");
}

export function tryGetWorkflowDispatchLeaseFile(dataRoot: string | undefined, runId: string): string | null {
  return typeof dataRoot === "string" && dataRoot.trim().length > 0
    ? getWorkflowDispatchLeaseFile(dataRoot, runId)
    : null;
}

export function createDispatchLeaseIndex(now = new Date()): DispatchLeaseIndex {
  return {
    schemaVersion: DISPATCH_LEASE_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    leases: []
  };
}

const leaseMutationQueues = new Map<string, Promise<void>>();

function normalizeLeaseFileKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function withDispatchLeaseMutation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = normalizeLeaseFileKey(filePath);
  const previous = leaseMutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => {}).then(() => next);
  leaseMutationQueues.set(key, chained);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (leaseMutationQueues.get(key) === chained) {
      leaseMutationQueues.delete(key);
    }
  }
}

function normalizeStatus(status: unknown): DispatchLeaseStatus {
  return status === "open" ||
    status === "closing" ||
    status === "retrying" ||
    status === "cooldown" ||
    status === "closed"
    ? status
    : "open";
}

function normalizeLease(raw: unknown): DispatchLeaseRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const dispatchId = typeof row.dispatch_id === "string" ? row.dispatch_id.trim() : "";
  const scopeKind = row.scope_kind === "project" || row.scope_kind === "workflow" ? row.scope_kind : null;
  const scopeId = typeof row.scope_id === "string" ? row.scope_id.trim() : "";
  const sessionId = typeof row.session_id === "string" ? row.session_id.trim() : "";
  if (!dispatchId || !scopeKind || !scopeId || !sessionId) return null;
  const now = new Date().toISOString();
  const role = typeof row.role === "string" ? row.role.trim() : "";
  const dispatchKind = row.dispatch_kind === "task" || row.dispatch_kind === "message" ? row.dispatch_kind : null;
  return {
    dispatch_id: dispatchId,
    scope_kind: scopeKind,
    scope_id: scopeId,
    session_id: sessionId,
    role,
    dispatch_kind: dispatchKind,
    task_id: typeof row.task_id === "string" ? row.task_id : null,
    message_id: typeof row.message_id === "string" ? row.message_id : null,
    status: normalizeStatus(row.status),
    created_at: typeof row.created_at === "string" ? row.created_at : now,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : now,
    expires_at: typeof row.expires_at === "string" ? row.expires_at : now,
    heartbeat_at: typeof row.heartbeat_at === "string" ? row.heartbeat_at : now,
    recovery_attempt_id: typeof row.recovery_attempt_id === "string" ? row.recovery_attempt_id : null
  };
}

export async function readDispatchLeaseIndex(repository: Repository, filePath: string): Promise<DispatchLeaseIndex> {
  const raw = await repository.readJson<Partial<DispatchLeaseIndex>>(filePath, createDispatchLeaseIndex());
  const now = new Date().toISOString();
  return {
    schemaVersion: DISPATCH_LEASE_SCHEMA_VERSION,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
    leases: Array.isArray(raw.leases)
      ? raw.leases.map(normalizeLease).filter((item): item is DispatchLeaseRecord => item !== null)
      : []
  };
}

async function writeDispatchLeaseIndex(
  repository: Repository,
  filePath: string,
  index: DispatchLeaseIndex,
  now = new Date()
): Promise<void> {
  await repository.ensureDirectory(path.dirname(filePath));
  await repository.writeJson(filePath, {
    ...index,
    schemaVersion: DISPATCH_LEASE_SCHEMA_VERSION,
    updatedAt: now.toISOString()
  });
}

function leaseMatchesTarget(lease: DispatchLeaseRecord, input: DispatchLeaseMatchInput): boolean {
  return (
    lease.scope_kind === input.scopeKind && lease.scope_id === input.scopeId && lease.session_id === input.sessionId
  );
}

function isLeaseExpired(lease: Pick<DispatchLeaseRecord, "expires_at">, now = new Date()): boolean {
  const expiresMs = Date.parse(lease.expires_at);
  return !Number.isFinite(expiresMs) || expiresMs <= now.getTime();
}

function isActiveDispatchLease(lease: DispatchLeaseRecord, now = new Date()): boolean {
  return (
    (lease.status === "open" || lease.status === "closing" || lease.status === "retrying") &&
    !isLeaseExpired(lease, now)
  );
}

export async function findBlockingDispatchLease(
  repository: Repository,
  filePath: string,
  input: DispatchLeaseMatchInput
): Promise<DispatchLeaseRecord | null> {
  const now = input.now ?? new Date();
  const index = await readDispatchLeaseIndex(repository, filePath);
  return index.leases.find((lease) => leaseMatchesTarget(lease, input) && isActiveDispatchLease(lease, now)) ?? null;
}

export async function countActiveDispatchLeases(
  repository: Repository,
  filePath: string,
  input: { scopeKind: DispatchLeaseScopeKind; scopeId: string; now?: Date }
): Promise<number> {
  const now = input.now ?? new Date();
  const index = await readDispatchLeaseIndex(repository, filePath);
  return index.leases.filter(
    (lease) =>
      lease.scope_kind === input.scopeKind && lease.scope_id === input.scopeId && isActiveDispatchLease(lease, now)
  ).length;
}

export async function upsertDispatchLease(
  repository: Repository,
  filePath: string,
  input: UpsertDispatchLeaseInput,
  options: { now?: Date; ttlMs?: number } = {}
): Promise<DispatchLeaseRecord> {
  return await withDispatchLeaseMutation(filePath, async () => {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + (options.ttlMs ?? DEFAULT_DISPATCH_LEASE_TTL_MS)).toISOString();
    const index = await readDispatchLeaseIndex(repository, filePath);
    const existingIndex = index.leases.findIndex((lease) => lease.dispatch_id === input.dispatchId);
    const previous = existingIndex >= 0 ? index.leases[existingIndex] : null;
    const lease: DispatchLeaseRecord = {
      dispatch_id: input.dispatchId,
      scope_kind: input.scopeKind,
      scope_id: input.scopeId,
      session_id: input.sessionId,
      role: input.role,
      dispatch_kind: input.dispatchKind,
      task_id: input.taskId ?? null,
      message_id: input.messageId ?? null,
      status: input.status ?? previous?.status ?? "open",
      created_at: previous?.created_at ?? nowIso,
      updated_at: nowIso,
      expires_at: expiresAt,
      heartbeat_at: nowIso,
      recovery_attempt_id: input.recoveryAttemptId ?? previous?.recovery_attempt_id ?? null
    };
    if (existingIndex >= 0) {
      index.leases[existingIndex] = lease;
    } else {
      index.leases.push(lease);
    }
    await writeDispatchLeaseIndex(repository, filePath, index, now);
    return lease;
  });
}

export async function reserveDispatchLease(
  repository: Repository,
  filePath: string,
  input: UpsertDispatchLeaseInput,
  options: { maxActive: number; now?: Date; ttlMs?: number }
): Promise<ReserveDispatchLeaseResult> {
  return await withDispatchLeaseMutation(filePath, async () => {
    const now = options.now ?? new Date();
    const maxActive = Math.max(0, Math.floor(options.maxActive));
    const index = await readDispatchLeaseIndex(repository, filePath);
    const activeCount = index.leases.filter(
      (lease) =>
        lease.dispatch_id !== input.dispatchId &&
        lease.scope_kind === input.scopeKind &&
        lease.scope_id === input.scopeId &&
        isActiveDispatchLease(lease, now)
    ).length;
    if (activeCount >= maxActive) {
      return { reserved: false, activeCount, maxActive };
    }

    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + (options.ttlMs ?? DEFAULT_DISPATCH_LEASE_TTL_MS)).toISOString();
    const existingIndex = index.leases.findIndex((lease) => lease.dispatch_id === input.dispatchId);
    const previous = existingIndex >= 0 ? index.leases[existingIndex] : null;
    const lease: DispatchLeaseRecord = {
      dispatch_id: input.dispatchId,
      scope_kind: input.scopeKind,
      scope_id: input.scopeId,
      session_id: input.sessionId,
      role: input.role,
      dispatch_kind: input.dispatchKind,
      task_id: input.taskId ?? null,
      message_id: input.messageId ?? null,
      status: input.status ?? previous?.status ?? "open",
      created_at: previous?.created_at ?? nowIso,
      updated_at: nowIso,
      expires_at: expiresAt,
      heartbeat_at: nowIso,
      recovery_attempt_id: input.recoveryAttemptId ?? previous?.recovery_attempt_id ?? null
    };
    if (existingIndex >= 0) {
      index.leases[existingIndex] = lease;
    } else {
      index.leases.push(lease);
    }
    await writeDispatchLeaseIndex(repository, filePath, index, now);
    return { reserved: true, activeCount: activeCount + 1, maxActive, lease };
  });
}

export async function heartbeatDispatchLease(
  repository: Repository,
  filePath: string,
  dispatchId: string,
  options: { now?: Date; ttlMs?: number } = {}
): Promise<DispatchLeaseRecord | null> {
  return await withDispatchLeaseMutation(filePath, async () => {
    const now = options.now ?? new Date();
    const index = await readDispatchLeaseIndex(repository, filePath);
    const lease = index.leases.find((item) => item.dispatch_id === dispatchId);
    if (!lease || lease.status === "closed") return null;
    lease.heartbeat_at = now.toISOString();
    lease.updated_at = lease.heartbeat_at;
    lease.expires_at = new Date(now.getTime() + (options.ttlMs ?? DEFAULT_DISPATCH_LEASE_TTL_MS)).toISOString();
    await writeDispatchLeaseIndex(repository, filePath, index, now);
    return { ...lease };
  });
}

export async function closeDispatchLease(
  repository: Repository,
  filePath: string,
  dispatchId: string,
  options: { now?: Date; status?: DispatchLeaseStatus } = {}
): Promise<DispatchLeaseRecord | null> {
  return await withDispatchLeaseMutation(filePath, async () => {
    const now = options.now ?? new Date();
    const index = await readDispatchLeaseIndex(repository, filePath);
    const lease = index.leases.find((item) => item.dispatch_id === dispatchId);
    if (!lease) return null;
    lease.status = options.status ?? "closed";
    lease.updated_at = now.toISOString();
    lease.expires_at = lease.updated_at;
    await writeDispatchLeaseIndex(repository, filePath, index, now);
    return { ...lease };
  });
}

export async function recoverExpiredDispatchLeases(
  repository: Repository,
  filePath: string,
  options: { now?: Date; createRecoveryAttemptId?: () => string } = {}
): Promise<DispatchLeaseRecord[]> {
  return await withDispatchLeaseMutation(filePath, async () => {
    const now = options.now ?? new Date();
    const createRecoveryAttemptId = options.createRecoveryAttemptId ?? (() => randomUUID());
    const index = await readDispatchLeaseIndex(repository, filePath);
    const recovered: DispatchLeaseRecord[] = [];
    for (const lease of index.leases) {
      if (
        (lease.status === "open" || lease.status === "closing" || lease.status === "retrying") &&
        isLeaseExpired(lease, now)
      ) {
        lease.status = "cooldown";
        lease.updated_at = now.toISOString();
        lease.recovery_attempt_id = lease.recovery_attempt_id ?? createRecoveryAttemptId();
        recovered.push({ ...lease });
      }
    }
    if (recovered.length > 0) {
      await writeDispatchLeaseIndex(repository, filePath, index, now);
    }
    return recovered;
  });
}

export async function reconcileDispatchLeasesFromEvents(
  repository: Repository,
  filePath: string,
  input: {
    scopeKind: DispatchLeaseScopeKind;
    scopeId: string;
    events: readonly DispatchLeaseEventLike[];
    defaultRole?: string;
    now?: Date;
    ttlMs?: number;
  }
): Promise<DispatchLeaseRecord[]> {
  const terminalDispatchIds = new Set<string>();
  const started = new Map<string, DispatchLeaseEventLike>();
  for (const event of input.events) {
    const payload =
      event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
    const dispatchId = readPayloadString(payload, "dispatchId") ?? readPayloadString(payload, "dispatch_id");
    if (!dispatchId) continue;
    if (event.eventType === "ORCHESTRATOR_DISPATCH_STARTED") {
      started.set(dispatchId, event);
      continue;
    }
    if (event.eventType === "ORCHESTRATOR_DISPATCH_FINISHED" || event.eventType === "ORCHESTRATOR_DISPATCH_FAILED") {
      terminalDispatchIds.add(dispatchId);
      started.delete(dispatchId);
    }
  }
  return await withDispatchLeaseMutation(filePath, async () => {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_DISPATCH_LEASE_TTL_MS)).toISOString();
    const index = await readDispatchLeaseIndex(repository, filePath);
    for (const dispatchId of terminalDispatchIds) {
      const lease = index.leases.find((item) => item.dispatch_id === dispatchId);
      if (lease) {
        lease.status = "closed";
        lease.updated_at = nowIso;
        lease.expires_at = nowIso;
      }
    }
    const leases: DispatchLeaseRecord[] = [];
    for (const [dispatchId, event] of started) {
      if (terminalDispatchIds.has(dispatchId) || !event.sessionId) continue;
      const payload =
        event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
      const existingIndex = index.leases.findIndex((lease) => lease.dispatch_id === dispatchId);
      const previous = existingIndex >= 0 ? index.leases[existingIndex] : null;
      const lease: DispatchLeaseRecord = {
        dispatch_id: dispatchId,
        scope_kind: input.scopeKind,
        scope_id: input.scopeId,
        session_id: event.sessionId,
        role: readPayloadString(payload, "role") ?? input.defaultRole ?? "",
        dispatch_kind: readPayloadString(payload, "dispatchKind") === "message" ? "message" : "task",
        task_id: event.taskId ?? readPayloadString(payload, "taskId") ?? null,
        message_id: readPayloadString(payload, "messageId") ?? null,
        status: previous?.status === "closed" ? "closed" : "open",
        created_at: previous?.created_at ?? nowIso,
        updated_at: nowIso,
        expires_at: expiresAt,
        heartbeat_at: nowIso,
        recovery_attempt_id:
          readPayloadString(payload, "recovery_attempt_id") ??
          readPayloadString(payload, "recoveryAttemptId") ??
          previous?.recovery_attempt_id ??
          null
      };
      if (existingIndex >= 0) {
        index.leases[existingIndex] = lease;
      } else {
        index.leases.push(lease);
      }
      leases.push({ ...lease });
    }
    if (terminalDispatchIds.size > 0 || leases.length > 0) {
      await writeDispatchLeaseIndex(repository, filePath, index, now);
    }
    return leases;
  });
}
