import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  readJsonFile,
  writeJsonFile,
  appendJsonlLine,
  readJsonlLines
} from "../../data/internal/persistence/store/store-runtime.js";
import type {
  TriggerAuditEvent,
  TriggerAuditEventType,
  TriggerConfigRecord,
  TriggerPluginRecord,
  TriggerRegistryState,
  TriggerSessionBindingRecord,
  TriggerRunHistoryItem
} from "./trigger-types.js";

export class TriggerStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_TRIGGER_ID"
      | "INVALID_PLUGIN_ID"
      | "PLUGIN_NOT_FOUND"
      | "PLUGIN_EXISTS"
      | "TRIGGER_NOT_FOUND"
      | "TRIGGER_EXISTS"
  ) {
    super(message);
  }
}

function triggersRoot(dataRoot: string): string {
  return path.join(dataRoot, "triggers");
}

function registryPath(dataRoot: string): string {
  return path.join(triggersRoot(dataRoot), "registry.json");
}

function auditPath(dataRoot: string): string {
  return path.join(triggersRoot(dataRoot), "audit.jsonl");
}

export function triggerPluginPackagesRoot(dataRoot: string): string {
  return path.join(triggersRoot(dataRoot), "plugins");
}

export function triggerPluginDataDir(dataRoot: string, pluginId: string, triggerId: string): string {
  return path.join(triggersRoot(dataRoot), "plugin-data", pluginId, triggerId);
}

function defaultRegistry(): TriggerRegistryState {
  return {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    plugins: [],
    triggers: [],
    sessionBindings: []
  };
}

function assertId(raw: string, kind: "trigger" | "plugin"): string {
  const value = raw.trim();
  if (!/^[a-zA-Z0-9._:-]+$/.test(value)) {
    throw new TriggerStoreError(
      `${kind}_id is invalid`,
      kind === "trigger" ? "INVALID_TRIGGER_ID" : "INVALID_PLUGIN_ID"
    );
  }
  return value;
}

function normalizeStringMap(raw: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!raw) {
    return undefined;
  }
  const entries = Object.entries(raw)
    .map(([key, value]) => [key.trim(), String(value).trim()] as const)
    .filter(([key]) => key.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function buildSessionBindingId(input: {
  triggerId: string;
  workflowTemplateId: string;
  role: string;
  provider: string;
}): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        triggerId: input.triggerId,
        workflowTemplateId: input.workflowTemplateId,
        role: input.role,
        provider: input.provider
      })
    )
    .digest("hex")
    .slice(0, 24);
  return `trigger-session-binding-${hash}`;
}

function normalizeSessionBindings(raw: unknown): TriggerSessionBindingRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const byId = new Map<string, TriggerSessionBindingRecord>();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as TriggerSessionBindingRecord;
    const triggerId = typeof entry.triggerId === "string" ? entry.triggerId.trim() : "";
    const workflowTemplateId = typeof entry.workflowTemplateId === "string" ? entry.workflowTemplateId.trim() : "";
    const role = typeof entry.role === "string" ? entry.role.trim() : "";
    const provider = entry.provider;
    if (
      !triggerId ||
      !workflowTemplateId ||
      !role ||
      (provider !== "codex" && provider !== "minimax" && provider !== "dpagent")
    ) {
      continue;
    }
    const bindingId = buildSessionBindingId({ triggerId, workflowTemplateId, role, provider });
    byId.set(bindingId, {
      ...entry,
      schemaVersion: "1.0",
      bindingId,
      triggerId,
      workflowTemplateId,
      role,
      provider
    });
  }
  return Array.from(byId.values());
}

async function readRegistry(dataRoot: string): Promise<TriggerRegistryState> {
  const state = await readJsonFile<TriggerRegistryState>(registryPath(dataRoot), defaultRegistry());
  return {
    schemaVersion: "1.0",
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : new Date().toISOString(),
    plugins: Array.isArray(state.plugins) ? state.plugins : [],
    triggers: Array.isArray(state.triggers)
      ? state.triggers.map((item) => ({
          ...item,
          sessionMode: item.sessionMode === "reuse_provider_session" ? "reuse_provider_session" : "fresh"
        }))
      : [],
    sessionBindings: normalizeSessionBindings(state.sessionBindings)
  };
}

async function writeRegistry(dataRoot: string, state: TriggerRegistryState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  state.plugins.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  state.triggers.sort((a, b) => a.triggerId.localeCompare(b.triggerId));
  state.sessionBindings.sort((a, b) => a.bindingId.localeCompare(b.bindingId));
  await writeJsonFile(registryPath(dataRoot), state);
}

export async function listTriggerPlugins(dataRoot: string): Promise<TriggerPluginRecord[]> {
  const state = await readRegistry(dataRoot);
  return [...state.plugins].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

export async function getTriggerPlugin(dataRoot: string, pluginIdRaw: string): Promise<TriggerPluginRecord | null> {
  const pluginId = assertId(pluginIdRaw, "plugin");
  const state = await readRegistry(dataRoot);
  return state.plugins.find((item) => item.pluginId === pluginId) ?? null;
}

export async function upsertTriggerPlugin(
  dataRoot: string,
  input: Omit<TriggerPluginRecord, "schemaVersion" | "createdAt" | "updatedAt">
): Promise<TriggerPluginRecord> {
  const pluginId = assertId(input.pluginId, "plugin");
  const state = await readRegistry(dataRoot);
  const existingIndex = state.plugins.findIndex((item) => item.pluginId === pluginId);
  const now = new Date().toISOString();
  const existing = existingIndex >= 0 ? state.plugins[existingIndex] : null;
  const record: TriggerPluginRecord = {
    schemaVersion: "1.0",
    pluginId,
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    entry: input.entry,
    sourcePath: input.sourcePath,
    packagePath: input.packagePath,
    hasCompletionHook: input.hasCompletionHook,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  if (existingIndex >= 0) {
    state.plugins[existingIndex] = record;
  } else {
    state.plugins.push(record);
  }
  await writeRegistry(dataRoot, state);
  return record;
}

export async function listTriggers(dataRoot: string): Promise<TriggerConfigRecord[]> {
  const state = await readRegistry(dataRoot);
  return [...state.triggers].sort((a, b) => a.triggerId.localeCompare(b.triggerId));
}

export async function getTrigger(dataRoot: string, triggerIdRaw: string): Promise<TriggerConfigRecord | null> {
  const triggerId = assertId(triggerIdRaw, "trigger");
  const state = await readRegistry(dataRoot);
  return state.triggers.find((item) => item.triggerId === triggerId) ?? null;
}

export async function createTrigger(
  dataRoot: string,
  input: {
    triggerId: string;
    pluginId: string;
    enabled: boolean;
    intervalSeconds: number;
    workflowTemplateId: string;
    workspacePath: string;
    defaultVariables?: Record<string, string>;
    hookTimeoutMs: number;
    sessionMode: TriggerConfigRecord["sessionMode"];
  }
): Promise<TriggerConfigRecord> {
  const triggerId = assertId(input.triggerId, "trigger");
  const pluginId = assertId(input.pluginId, "plugin");
  const state = await readRegistry(dataRoot);
  if (!state.plugins.some((item) => item.pluginId === pluginId)) {
    throw new TriggerStoreError(`plugin '${pluginId}' not found`, "PLUGIN_NOT_FOUND");
  }
  if (state.triggers.some((item) => item.triggerId === triggerId)) {
    throw new TriggerStoreError(`trigger '${triggerId}' already exists`, "TRIGGER_EXISTS");
  }
  const now = new Date().toISOString();
  const record: TriggerConfigRecord = {
    schemaVersion: "1.0",
    triggerId,
    pluginId,
    enabled: input.enabled,
    intervalSeconds: Math.max(1, Math.floor(input.intervalSeconds)),
    workflowTemplateId: input.workflowTemplateId.trim(),
    workspacePath: path.resolve(input.workspacePath),
    defaultVariables: normalizeStringMap(input.defaultVariables),
    hookTimeoutMs: Math.max(1, Math.floor(input.hookTimeoutMs)),
    sessionMode: input.sessionMode === "reuse_provider_session" ? "reuse_provider_session" : "fresh",
    nextCheckAt: now,
    createdAt: now,
    updatedAt: now
  };
  state.triggers.push(record);
  await writeRegistry(dataRoot, state);
  return record;
}

export async function patchTrigger(
  dataRoot: string,
  triggerIdRaw: string,
  patch: {
    pluginId?: string;
    enabled?: boolean;
    intervalSeconds?: number;
    workflowTemplateId?: string;
    workspacePath?: string;
    defaultVariables?: Record<string, string> | null;
    hookTimeoutMs?: number;
    sessionMode?: TriggerConfigRecord["sessionMode"];
    lastCheckedAt?: string;
    nextCheckAt?: string;
    lastFireId?: string;
  }
): Promise<TriggerConfigRecord> {
  const triggerId = assertId(triggerIdRaw, "trigger");
  const state = await readRegistry(dataRoot);
  const index = state.triggers.findIndex((item) => item.triggerId === triggerId);
  if (index < 0) {
    throw new TriggerStoreError(`trigger '${triggerId}' not found`, "TRIGGER_NOT_FOUND");
  }
  const existing = state.triggers[index];
  const pluginId = patch.pluginId ? assertId(patch.pluginId, "plugin") : existing.pluginId;
  if (!state.plugins.some((item) => item.pluginId === pluginId)) {
    throw new TriggerStoreError(`plugin '${pluginId}' not found`, "PLUGIN_NOT_FOUND");
  }
  const updated: TriggerConfigRecord = {
    ...existing,
    pluginId,
    enabled: patch.enabled ?? existing.enabled,
    intervalSeconds:
      patch.intervalSeconds === undefined ? existing.intervalSeconds : Math.max(1, Math.floor(patch.intervalSeconds)),
    workflowTemplateId: patch.workflowTemplateId?.trim() || existing.workflowTemplateId,
    workspacePath: patch.workspacePath ? path.resolve(patch.workspacePath) : existing.workspacePath,
    defaultVariables:
      patch.defaultVariables === undefined
        ? existing.defaultVariables
        : patch.defaultVariables === null
          ? undefined
          : normalizeStringMap(patch.defaultVariables),
    hookTimeoutMs:
      patch.hookTimeoutMs === undefined ? existing.hookTimeoutMs : Math.max(1, Math.floor(patch.hookTimeoutMs)),
    sessionMode: patch.sessionMode ?? existing.sessionMode,
    lastCheckedAt: patch.lastCheckedAt ?? existing.lastCheckedAt,
    nextCheckAt: patch.nextCheckAt ?? existing.nextCheckAt,
    lastFireId: patch.lastFireId ?? existing.lastFireId,
    updatedAt: new Date().toISOString()
  };
  state.triggers[index] = updated;
  await writeRegistry(dataRoot, state);
  return updated;
}

export async function deleteTrigger(dataRoot: string, triggerIdRaw: string): Promise<TriggerConfigRecord> {
  const triggerId = assertId(triggerIdRaw, "trigger");
  const state = await readRegistry(dataRoot);
  const index = state.triggers.findIndex((item) => item.triggerId === triggerId);
  if (index < 0) {
    throw new TriggerStoreError(`trigger '${triggerId}' not found`, "TRIGGER_NOT_FOUND");
  }
  const [removed] = state.triggers.splice(index, 1);
  state.sessionBindings = state.sessionBindings.filter((item) => item.triggerId !== triggerId);
  await writeRegistry(dataRoot, state);
  return removed;
}

export async function listTriggerSessionBindings(
  dataRoot: string,
  triggerIdRaw: string
): Promise<TriggerSessionBindingRecord[]> {
  const triggerId = assertId(triggerIdRaw, "trigger");
  const state = await readRegistry(dataRoot);
  return state.sessionBindings
    .filter((item) => item.triggerId === triggerId)
    .sort((a, b) => a.role.localeCompare(b.role) || a.provider.localeCompare(b.provider));
}

export async function getTriggerSessionBinding(
  dataRoot: string,
  input: Pick<TriggerSessionBindingRecord, "triggerId" | "workflowTemplateId" | "role" | "provider">
): Promise<TriggerSessionBindingRecord | null> {
  const state = await readRegistry(dataRoot);
  const bindingId = buildSessionBindingId(input);
  return state.sessionBindings.find((item) => item.bindingId === bindingId) ?? null;
}

export async function upsertTriggerSessionBinding(
  dataRoot: string,
  input: Pick<TriggerSessionBindingRecord, "triggerId" | "workflowTemplateId" | "role" | "provider"> & {
    providerSessionId?: string | null;
    activeFireId?: string | null;
    activeWorkflowRunId?: string | null;
    lastFireId?: string;
    lastWorkflowRunId?: string;
  }
): Promise<TriggerSessionBindingRecord> {
  const triggerId = assertId(input.triggerId, "trigger");
  const state = await readRegistry(dataRoot);
  const bindingId = buildSessionBindingId({
    triggerId,
    workflowTemplateId: input.workflowTemplateId.trim(),
    role: input.role.trim(),
    provider: input.provider
  });
  const now = new Date().toISOString();
  const index = state.sessionBindings.findIndex((item) => item.bindingId === bindingId);
  const existing = index >= 0 ? state.sessionBindings[index] : undefined;
  const providerSessionId =
    input.providerSessionId === null ? undefined : input.providerSessionId?.trim() || existing?.providerSessionId;
  const record: TriggerSessionBindingRecord = {
    schemaVersion: "1.0",
    bindingId,
    triggerId,
    workflowTemplateId: input.workflowTemplateId.trim(),
    role: input.role.trim(),
    provider: input.provider,
    providerSessionId,
    activeFireId: input.activeFireId === null ? undefined : input.activeFireId?.trim() || existing?.activeFireId,
    activeWorkflowRunId:
      input.activeWorkflowRunId === null
        ? undefined
        : input.activeWorkflowRunId?.trim() || existing?.activeWorkflowRunId,
    lastFireId: input.lastFireId?.trim() || existing?.lastFireId,
    lastWorkflowRunId: input.lastWorkflowRunId?.trim() || existing?.lastWorkflowRunId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastObservedAt: providerSessionId ? now : existing?.lastObservedAt
  };
  if (index >= 0) {
    state.sessionBindings[index] = record;
  } else {
    state.sessionBindings.push(record);
  }
  await writeRegistry(dataRoot, state);
  return record;
}

export async function clearTriggerSessionBindingActiveRun(
  dataRoot: string,
  triggerIdRaw: string,
  workflowRunId: string
): Promise<TriggerSessionBindingRecord[]> {
  const triggerId = assertId(triggerIdRaw, "trigger");
  const state = await readRegistry(dataRoot);
  const now = new Date().toISOString();
  const updated: TriggerSessionBindingRecord[] = [];
  for (const binding of state.sessionBindings) {
    if (binding.triggerId !== triggerId || binding.activeWorkflowRunId !== workflowRunId) {
      continue;
    }
    binding.activeFireId = undefined;
    binding.activeWorkflowRunId = undefined;
    binding.updatedAt = now;
    updated.push(binding);
  }
  if (updated.length > 0) {
    await writeRegistry(dataRoot, state);
  }
  return updated;
}

export async function resetTriggerSessionBindings(
  dataRoot: string,
  triggerIdRaw: string,
  filter: { role?: string; provider?: string } = {}
): Promise<TriggerSessionBindingRecord[]> {
  const triggerId = assertId(triggerIdRaw, "trigger");
  const state = await readRegistry(dataRoot);
  const removed: TriggerSessionBindingRecord[] = [];
  state.sessionBindings = state.sessionBindings.filter((item) => {
    const matches =
      item.triggerId === triggerId &&
      (!filter.role || item.role === filter.role) &&
      (!filter.provider || item.provider === filter.provider);
    if (matches) {
      removed.push(item);
      return false;
    }
    return true;
  });
  if (removed.length > 0) {
    await writeRegistry(dataRoot, state);
  }
  return removed;
}

export async function appendTriggerAudit(
  dataRoot: string,
  input: {
    eventType: TriggerAuditEventType;
    triggerId?: string;
    pluginId?: string;
    fireId?: string;
    payload?: Record<string, unknown>;
  }
): Promise<TriggerAuditEvent> {
  const event: TriggerAuditEvent = {
    schemaVersion: "1.0",
    eventId: `trigger-event-${randomUUID()}`,
    triggerId: input.triggerId,
    pluginId: input.pluginId,
    fireId: input.fireId,
    eventType: input.eventType,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {}
  };
  await appendJsonlLine(auditPath(dataRoot), event);
  return event;
}

export async function listTriggerAudit(dataRoot: string): Promise<TriggerAuditEvent[]> {
  return readJsonlLines<TriggerAuditEvent>(auditPath(dataRoot));
}

export async function listTriggerRunHistory(dataRoot: string, triggerIdRaw: string): Promise<TriggerRunHistoryItem[]> {
  const triggerId = assertId(triggerIdRaw, "trigger");
  const events = (await listTriggerAudit(dataRoot)).filter((event) => event.triggerId === triggerId && event.fireId);
  const byFire = new Map<string, TriggerRunHistoryItem>();
  for (const event of events) {
    const fireId = event.fireId ?? "";
    const existing = byFire.get(fireId);
    const base: TriggerRunHistoryItem =
      existing ??
      ({
        fireId,
        triggerId,
        pluginId: event.pluginId ?? "",
        status: "failed",
        startedAt: event.createdAt,
        updatedAt: event.createdAt
      } satisfies TriggerRunHistoryItem);
    base.updatedAt = event.createdAt;
    if (event.eventType === "TRIGGER_CHECK_SKIPPED") {
      base.status = "skipped";
      base.reason = typeof event.payload.reason === "string" ? event.payload.reason : base.reason;
    } else if (
      event.eventType === "TRIGGER_HOOK_FAILED" ||
      event.eventType === "TRIGGER_WORKFLOW_RUN_START_FAILED" ||
      event.eventType === "TRIGGER_COMPLETION_HOOK_FAILED" ||
      event.eventType === "TRIGGER_WORKFLOW_COMPLETION_FAILED"
    ) {
      base.status = "failed";
      base.error = typeof event.payload.error === "string" ? event.payload.error : base.error;
    } else if (event.eventType === "TRIGGER_WORKFLOW_RUN_CREATED") {
      base.status = "fired";
      base.workflowRunId =
        typeof event.payload.workflowRunId === "string" ? event.payload.workflowRunId : base.workflowRunId;
      base.reason = typeof event.payload.reason === "string" ? event.payload.reason : base.reason;
    } else if (event.eventType === "TRIGGER_WORKFLOW_COMPLETED") {
      base.status = "completed";
      base.workflowRunId =
        typeof event.payload.workflowRunId === "string" ? event.payload.workflowRunId : base.workflowRunId;
      base.completionVerdict =
        event.payload.verdict && typeof event.payload.verdict === "object"
          ? (event.payload.verdict as TriggerRunHistoryItem["completionVerdict"])
          : base.completionVerdict;
    }
    byFire.set(fireId, base);
  }
  return Array.from(byFire.values()).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export async function replaceDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
}
