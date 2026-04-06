import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderId } from "@autodev/agent-library";
import type { ProjectPaths, ProjectRecord, ProjectSummary, RoleReminderState } from "../../../domain/models.js";
import { DISCUSS_HARD_MAX_ROUNDS } from "../../../services/discuss-policy-service.js";
import { getRepository, getUnitOfWork } from "../shared/runtime.js";
import { getRoleReminderState, updateRoleReminderState } from "./role-reminder-repository.js";

const repository = getRepository();
const unitOfWork = getUnitOfWork();

export class ProjectStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_PROJECT_ID"
      | "PROJECT_EXISTS"
      | "PROJECT_NOT_FOUND"
      | "INVALID_ROUTE_TABLE"
      | "PROJECT_RUNTIME_BUSY"
  ) {
    super(message);
  }
}

interface CreateProjectInput {
  projectId: string;
  name: string;
  workspacePath: string;
  templateId?: string;
  agentIds?: string[];
  routeTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  autoDispatchEnabled?: boolean;
  autoDispatchRemaining?: number;
  holdEnabled?: boolean;
  reminderMode?: "backoff" | "fixed_interval";
  roleSessionMap?: Record<string, string>;
}

interface ProjectOverview extends ProjectSummary {
  createdAt: string;
  updatedAt: string;
  inboxSessions: string[];
  templateId?: string;
  agentIds?: string[];
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  agentModelConfigs?: Record<
    string,
    { provider_id: ProviderId; model: string; effort?: "low" | "medium" | "high" }
  >;
  autoDispatchEnabled?: boolean;
  autoDispatchRemaining?: number;
  holdEnabled?: boolean;
  reminderMode?: "backoff" | "fixed_interval";
  roleSessionMap?: Record<string, string>;
}

function normalizeAgentId(agentId: string): string {
  return agentId.trim();
}

function normalizeAgentIds(agentIds?: string[]): string[] | undefined {
  if (!Array.isArray(agentIds)) {
    return undefined;
  }
  const normalized = agentIds
    .map((item) => normalizeAgentId(item))
    .filter((item) => item.length > 0);
  return Array.from(new Set(normalized));
}

function normalizeRouteTable(
  raw?: Record<string, string[]>,
  allowedAgents?: string[]
): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const allowed = new Set((allowedAgents ?? []).map((item) => normalizeAgentId(item)));
  const next: Record<string, string[]> = {};
  for (const [from, toList] of Object.entries(raw)) {
    const fromAgent = normalizeAgentId(from);
    if (!fromAgent) {
      continue;
    }
    if (allowed.size > 0 && !allowed.has(fromAgent)) {
      continue;
    }

    const targets = Array.isArray(toList)
      ? Array.from(
          new Set(
            toList
              .map((item) => normalizeAgentId(String(item)))
              .filter((item) => item.length > 0)
              .filter((item) => (allowed.size > 0 ? allowed.has(item) : true))
          )
        )
      : [];
    next[fromAgent] = targets;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeRouteDiscussRounds(
  raw?: Record<string, Record<string, number>>,
  routeTable?: Record<string, string[]>,
  allowedAgents?: string[]
): Record<string, Record<string, number>> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const allowed = new Set((allowedAgents ?? []).map((item) => normalizeAgentId(item)));
  const next: Record<string, Record<string, number>> = {};
  for (const [fromRaw, toMapRaw] of Object.entries(raw)) {
    const from = normalizeAgentId(fromRaw);
    if (!from) {
      continue;
    }
    if (allowed.size > 0 && !allowed.has(from)) {
      continue;
    }
    if (!toMapRaw || typeof toMapRaw !== "object") {
      continue;
    }
    const allowedTargets = new Set((routeTable?.[from] ?? []).map((item) => normalizeAgentId(item)));
    const toMapNext: Record<string, number> = {};
    for (const [toRaw, maxRoundsRaw] of Object.entries(toMapRaw)) {
      const to = normalizeAgentId(toRaw);
      if (!to) {
        continue;
      }
      if (allowed.size > 0 && !allowed.has(to)) {
        continue;
      }
      if (allowedTargets.size > 0 && !allowedTargets.has(to)) {
        continue;
      }
      const maxRounds = Math.max(1, Math.min(DISCUSS_HARD_MAX_ROUNDS, Math.floor(Number(maxRoundsRaw))));
      if (!Number.isFinite(maxRounds)) {
        continue;
      }
      toMapNext[to] = maxRounds;
    }
    if (Object.keys(toMapNext).length > 0) {
      next[from] = toMapNext;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeAgentModelConfigs(
  raw?: Record<string, { provider_id: string; model: string; effort?: string }>,
  allowedAgents?: string[]
): Record<string, { provider_id: ProviderId; model: string; effort?: "low" | "medium" | "high" }> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const allowed = new Set((allowedAgents ?? []).map((item) => normalizeAgentId(item)));
  const next: Record<string, { provider_id: ProviderId; model: string; effort?: "low" | "medium" | "high" }> = {};
  
  for (const [agentId, config] of Object.entries(raw)) {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (!normalizedAgentId) {
      continue;
    }
    if (allowed.size > 0 && !allowed.has(normalizedAgentId)) {
      continue;
    }
    if (!config || typeof config !== "object") {
      continue;
    }
    const providerId =
      config.provider_id === "trae" ? "trae" : config.provider_id === "minimax" ? "minimax" : "codex";
    const model = typeof config.model === "string" ? config.model.trim() : "";
    const effortRaw = typeof config.effort === "string" ? config.effort.trim().toLowerCase() : "";
    const effort = effortRaw === "low" || effortRaw === "medium" || effortRaw === "high"
      ? (effortRaw as "low" | "medium" | "high")
      : undefined;
    
    next[normalizedAgentId] = {
      provider_id: providerId,
      model,
      effort
    };
  }
  
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeAutoDispatchEnabled(raw: unknown, fallback = true): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }
  return fallback;
}

function normalizeAutoDispatchRemaining(raw: unknown, fallback = 5): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.min(1000, Math.floor(raw)));
}

function normalizeHoldEnabled(raw: unknown, fallback = false): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }
  return fallback;
}

function normalizeReminderMode(raw: unknown, fallback: "backoff" | "fixed_interval" = "backoff"): "backoff" | "fixed_interval" {
  if (raw === "backoff" || raw === "fixed_interval") {
    return raw;
  }
  return fallback;
}

function assertProjectId(projectId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new ProjectStoreError(
      "project_id must match /^[a-zA-Z0-9_-]+$/",
      "INVALID_PROJECT_ID"
    );
  }
}

export function getProjectPaths(dataRoot: string, projectId: string): ProjectPaths {
  const projectRootDir = path.join(dataRoot, "projects", projectId);
  const collabDir = path.join(projectRootDir, "collab");
  return {
    projectRootDir,
    projectConfigFile: path.join(projectRootDir, "project.json"),
    collabDir,
    eventsFile: path.join(collabDir, "events.jsonl"),
    taskboardFile: path.join(collabDir, "state", "taskboard.json"),
    sessionsFile: path.join(collabDir, "state", "sessions.json"),
    roleRemindersFile: path.join(collabDir, "state", "role-reminders.json"),
    locksDir: path.join(collabDir, "locks"),
    inboxDir: path.join(collabDir, "inbox"),
    outboxDir: path.join(collabDir, "outbox"),
    auditDir: path.join(collabDir, "audit"),
    agentOutputFile: path.join(collabDir, "audit", "agent_output.jsonl"),
    promptsDir: path.join(collabDir, "prompts")
  };
}

function getTeamRequestsPaths(dataRoot: string, projectId: string) {
  const paths = getProjectPaths(dataRoot, projectId);
  const stateDir = path.join(paths.collabDir, "state");
  return {
    teamAgentRequestsFile: path.join(stateDir, "team_agent_requests.json"),
    routeChangeRequestsFile: path.join(stateDir, "route_change_requests.json")
  };
}

interface TeamAgentRequestsState {
  schemaVersion: "1.0";
  projectId: string;
  updatedAt: string;
  requests: Array<{
    requestId: string;
    fromAgent: string;
    fromSessionId: string;
    agentId: string;
    displayName: string;
    prompt: string;
    status: "pending" | "approved" | "rejected";
    createdAt: string;
    updatedAt: string;
  }>;
}

interface RouteChangeRequestsState {
  schemaVersion: "1.0";
  projectId: string;
  updatedAt: string;
  requests: Array<{
    requestId: string;
    fromAgent: string;
    fromSessionId: string;
    routeTable: Record<string, string[]>;
    agentIds?: string[];
    status: "pending" | "approved" | "rejected";
    createdAt: string;
    updatedAt: string;
  }>;
}

function emptyTaskboard(projectId: string) {
  const now = new Date().toISOString();
  const rootTaskId = `${projectId}-root`;
  return {
    schemaVersion: "1.0" as const,
    projectId,
    updatedAt: now,
    tasks: [
      {
        taskId: rootTaskId,
        taskKind: "PROJECT_ROOT" as const,
        parentTaskId: rootTaskId,
        rootTaskId: rootTaskId,
        title: `Project: ${projectId}`,
        ownerRole: "manager",
        ownerSession: undefined,
        state: "PLANNED" as const,
        priority: 0,
        writeSet: [],
        dependencies: [],
        acceptance: [],
        artifacts: [],
        createdAt: now,
        updatedAt: now
      }
    ]
  };
}

function emptySessions(projectId: string) {
  return {
    schemaVersion: "1.0" as const,
    projectId,
    updatedAt: new Date().toISOString(),
    sessions: []
  };
}

export async function ensureProjectRuntime(dataRoot: string, projectId: string): Promise<ProjectPaths> {
  assertProjectId(projectId);
  const paths = getProjectPaths(dataRoot, projectId);

  await repository.ensureDirectory(paths.projectRootDir);
  await repository.ensureDirectory(paths.collabDir);
  await repository.ensureDirectory(path.dirname(paths.taskboardFile));
  await repository.ensureDirectory(paths.locksDir);
  await repository.ensureDirectory(paths.inboxDir);
  await repository.ensureDirectory(paths.outboxDir);
  await repository.ensureDirectory(paths.auditDir);
  await repository.ensureDirectory(paths.promptsDir);

  await repository.ensureFile(paths.eventsFile, "");
  await repository.ensureFile(paths.taskboardFile, `${JSON.stringify(emptyTaskboard(projectId), null, 2)}\n`);
  await repository.ensureFile(paths.sessionsFile, `${JSON.stringify(emptySessions(projectId), null, 2)}\n`);
  await repository.ensureFile(paths.agentOutputFile, "");

  return paths;
}

export async function createProject(
  dataRoot: string,
  input: CreateProjectInput
): Promise<{ project: ProjectRecord; paths: ProjectPaths }> {
  const projectId = input.projectId.trim();
  assertProjectId(projectId);

  const now = new Date().toISOString();
  const paths = getProjectPaths(dataRoot, projectId);

  try {
    await fs.access(paths.projectConfigFile);
    throw new ProjectStoreError(`project '${projectId}' already exists`, "PROJECT_EXISTS");
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code && known.code !== "ENOENT") {
      throw error;
    }
  }

  await ensureProjectRuntime(dataRoot, projectId);
  const normalizedAgents = normalizeAgentIds(input.agentIds);
  const normalizedRouteTable = normalizeRouteTable(input.routeTable, normalizedAgents);
  const project: ProjectRecord = {
    schemaVersion: "1.0",
    projectId,
    name: input.name.trim() || `Project-${randomUUID().slice(0, 8)}`,
    workspacePath: path.resolve(input.workspacePath),
    templateId: input.templateId?.trim() || undefined,
    agentIds: normalizedAgents,
    routeTable: normalizedRouteTable,
    routeDiscussRounds: normalizeRouteDiscussRounds(
      input.routeDiscussRounds,
      normalizedRouteTable,
      normalizedAgents
    ),
    autoDispatchEnabled: normalizeAutoDispatchEnabled(input.autoDispatchEnabled, true),
    autoDispatchRemaining: normalizeAutoDispatchRemaining(input.autoDispatchRemaining, 5),
    holdEnabled: normalizeHoldEnabled(input.holdEnabled, false),
    reminderMode: normalizeReminderMode(input.reminderMode, "backoff"),
    createdAt: now,
    updatedAt: now,
    roleSessionMap: input.roleSessionMap
  };

  await unitOfWork.run([paths.projectConfigFile], async () => {
    await repository.writeJson(paths.projectConfigFile, project);
  });
  return { project, paths };
}

export async function getProject(dataRoot: string, projectId: string): Promise<ProjectRecord> {
  assertProjectId(projectId);
  const paths = getProjectPaths(dataRoot, projectId);
  const fallback = null as unknown as ProjectRecord;
  const project = await repository.readJson<ProjectRecord | null>(paths.projectConfigFile, fallback);
  if (!project) {
    throw new ProjectStoreError(`project '${projectId}' not found`, "PROJECT_NOT_FOUND");
  }
  return {
    ...project,
    autoDispatchEnabled: normalizeAutoDispatchEnabled(project.autoDispatchEnabled, true),
    autoDispatchRemaining: normalizeAutoDispatchRemaining(project.autoDispatchRemaining, 5),
    holdEnabled: normalizeHoldEnabled(project.holdEnabled, false),
    reminderMode: normalizeReminderMode(project.reminderMode, "backoff")
  };
}

async function readInboxSessions(inboxDir: string): Promise<string[]> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(inboxDir, { withFileTypes: true });
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name.replace(/\.jsonl$/i, ""))
    .sort((a, b) => a.localeCompare(b));
}

export async function listProjects(dataRoot: string): Promise<ProjectSummary[]> {
  const projectsDir = path.join(dataRoot, "projects");
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const items: ProjectSummary[] = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const projectId = entry.name;
    try {
      const record = await getProject(dataRoot, projectId);
      items.push({
        projectId: record.projectId,
        name: record.name,
        workspacePath: record.workspacePath,
        dataPath: `data/projects/${record.projectId}/collab`
      });
    } catch (error) {
      if (error instanceof ProjectStoreError && (error.code === "PROJECT_NOT_FOUND" || error.code === "INVALID_PROJECT_ID")) {
        continue;
      }
      throw error;
    }
  }

  return items.sort((a, b) => a.projectId.localeCompare(b.projectId));
}

export async function getProjectOverview(dataRoot: string, projectId: string): Promise<ProjectOverview> {
  const project = await getProject(dataRoot, projectId);
  const paths = await ensureProjectRuntime(dataRoot, projectId);
  const inboxSessions = await readInboxSessions(paths.inboxDir);
  return {
    projectId: project.projectId,
    name: project.name,
    workspacePath: project.workspacePath,
    dataPath: `data/projects/${project.projectId}/collab`,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    inboxSessions,
    templateId: project.templateId,
    agentIds: project.agentIds,
    routeTable: project.routeTable,
    taskAssignRouteTable: project.taskAssignRouteTable,
    routeDiscussRounds: project.routeDiscussRounds,
    agentModelConfigs: project.agentModelConfigs,
    autoDispatchEnabled: project.autoDispatchEnabled,
    autoDispatchRemaining: project.autoDispatchRemaining,
    holdEnabled: project.holdEnabled,
    reminderMode: project.reminderMode,
    roleSessionMap: project.roleSessionMap
  };
}

export function resolveSessionByRole(project: ProjectRecord, role?: string): string | undefined {
  if (!role) {
    return undefined;
  }
  const normalizedRole = role.trim();
  if (!normalizedRole) {
    return undefined;
  }
  return project.roleSessionMap?.[normalizedRole];
}

export function isProjectAgentEnabled(project: ProjectRecord, agentId: string): boolean {
  const normalizedAgent = normalizeAgentId(agentId);
  if (!normalizedAgent) {
    return false;
  }
  if (!project.agentIds || project.agentIds.length === 0) {
    return true;
  }
  return project.agentIds.includes(normalizedAgent);
}

export function isProjectRouteAllowed(
  project: ProjectRecord,
  fromAgentId: string,
  toAgentId: string
): boolean {
  const fromAgent = normalizeAgentId(fromAgentId);
  const toAgent = normalizeAgentId(toAgentId);
  if (!toAgent) {
    return false;
  }
  if (toAgent === "manager" || toAgent === "dashboard" || toAgent === "user" || toAgent === "system") {
    return true;
  }
  if (!isProjectAgentEnabled(project, toAgent)) {
    return false;
  }
  if (!fromAgent || fromAgent === "manager" || fromAgent === "dashboard" || fromAgent === "user" || fromAgent === "system") {
    return true;
  }
  if (!project.routeTable || Object.keys(project.routeTable).length === 0) {
    return true;
  }
  const allowedTargets = project.routeTable[fromAgent] ?? [];
  return allowedTargets.includes(toAgent);
}

export function isTaskAssignRouteAllowed(
  project: ProjectRecord,
  fromAgentId: string,
  toAgentId: string
): boolean {
  if (!isProjectRouteAllowed(project, fromAgentId, toAgentId)) {
    return false;
  }
  if (!project.taskAssignRouteTable || Object.keys(project.taskAssignRouteTable).length === 0) {
    return true;
  }
  const fromAgent = normalizeAgentId(fromAgentId);
  const toAgent = normalizeAgentId(toAgentId);
  if (!fromAgent || fromAgent === "manager" || fromAgent === "dashboard" || fromAgent === "user" || fromAgent === "system") {
    return true;
  }
  if (!toAgent || toAgent === "manager" || toAgent === "dashboard" || toAgent === "user" || toAgent === "system") {
    return true;
  }
  const allowedTargets = project.taskAssignRouteTable[fromAgent] ?? [];
  return allowedTargets.includes(toAgent);
}

export function validateTaskAssignRouteSubset(
  project: ProjectRecord,
  taskAssignRouteTable: Record<string, string[]>
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const [fromAgent, targets] of Object.entries(taskAssignRouteTable)) {
    for (const toAgent of targets) {
      if (!isProjectRouteAllowed(project, fromAgent, toAgent)) {
        violations.push(`${fromAgent} -> ${toAgent} is not allowed by project route table`);
      }
    }
  }
  return { valid: violations.length === 0, violations };
}

export async function setRoleSessionMapping(
  dataRoot: string,
  projectId: string,
  role: string,
  sessionId: string
): Promise<ProjectRecord> {
  const project = await getProject(dataRoot, projectId);
  const normalizedRole = role.trim();
  const normalizedSession = sessionId.trim();
  if (!normalizedRole || !normalizedSession) {
    return project;
  }

  const next: ProjectRecord = {
    ...project,
    roleSessionMap: {
      ...(project.roleSessionMap ?? {}),
      [normalizedRole]: normalizedSession
    },
    updatedAt: new Date().toISOString()
  };
  const paths = getProjectPaths(dataRoot, projectId);
  await repository.writeJson(paths.projectConfigFile, next);
  return next;
}

export async function clearRoleSessionMapping(
  dataRoot: string,
  projectId: string,
  role: string
): Promise<ProjectRecord> {
  const project = await getProject(dataRoot, projectId);
  const normalizedRole = role.trim();
  if (!normalizedRole || !project.roleSessionMap || !(normalizedRole in project.roleSessionMap)) {
    return project;
  }

  const nextMap = { ...project.roleSessionMap };
  delete nextMap[normalizedRole];

  const next: ProjectRecord = {
    ...project,
    roleSessionMap: Object.keys(nextMap).length > 0 ? nextMap : undefined,
    updatedAt: new Date().toISOString()
  };
  const paths = getProjectPaths(dataRoot, projectId);
  await repository.writeJson(paths.projectConfigFile, next);
  return next;
}

export async function updateProjectRouting(
  dataRoot: string,
  projectId: string,
  input: {
    agentIds: string[];
    routeTable: Record<string, string[]>;
    routeDiscussRounds?: Record<string, Record<string, number>>;
    agentModelConfigs?: Record<string, { provider_id: string; model: string; effort?: string }>;
  }
): Promise<ProjectRecord> {
  const project = await getProject(dataRoot, projectId);
  const normalizedAgents = normalizeAgentIds(input.agentIds) ?? [];
  const normalizedRouteTable = normalizeRouteTable(input.routeTable, normalizedAgents) ?? {};
  const normalizedDiscussRounds =
    normalizeRouteDiscussRounds(
      input.routeDiscussRounds,
      normalizedRouteTable,
      normalizedAgents
    ) ?? undefined;
  const normalizedAgentModelConfigs = normalizeAgentModelConfigs(input.agentModelConfigs, normalizedAgents);

  const next: ProjectRecord = {
    ...project,
    agentIds: normalizedAgents,
    routeTable: normalizedRouteTable,
    routeDiscussRounds: normalizedDiscussRounds,
    agentModelConfigs: normalizedAgentModelConfigs,
    updatedAt: new Date().toISOString()
  };
  const paths = getProjectPaths(dataRoot, projectId);
  await repository.writeJson(paths.projectConfigFile, next);
  return next;
}

export async function updateTaskAssignRouting(
  dataRoot: string,
  projectId: string,
  taskAssignRouteTable: Record<string, string[]>
): Promise<ProjectRecord> {
  const project = await getProject(dataRoot, projectId);
  const validation = validateTaskAssignRouteSubset(project, taskAssignRouteTable);
  if (!validation.valid) {
    throw new ProjectStoreError(
      `task assign route table must be subset of project route table: ${validation.violations.join("; ")}`,
      "INVALID_ROUTE_TABLE"
    );
  }
  const next: ProjectRecord = {
    ...project,
    taskAssignRouteTable,
    updatedAt: new Date().toISOString()
  };
  const paths = getProjectPaths(dataRoot, projectId);
  await repository.writeJson(paths.projectConfigFile, next);
  return next;
}

export async function updateProjectOrchestratorSettings(
  dataRoot: string,
  projectId: string,
  input: {
    autoDispatchEnabled?: boolean;
    autoDispatchRemaining?: number;
    holdEnabled?: boolean;
    reminderMode?: "backoff" | "fixed_interval";
  }
): Promise<ProjectRecord> {
  const project = await getProject(dataRoot, projectId);
  const next: ProjectRecord = {
    ...project,
    autoDispatchEnabled:
      input.autoDispatchEnabled === undefined
        ? normalizeAutoDispatchEnabled(project.autoDispatchEnabled, true)
        : normalizeAutoDispatchEnabled(input.autoDispatchEnabled, true),
    autoDispatchRemaining:
      input.autoDispatchRemaining === undefined
        ? normalizeAutoDispatchRemaining(project.autoDispatchRemaining, 5)
        : normalizeAutoDispatchRemaining(input.autoDispatchRemaining, 5),
    holdEnabled:
      input.holdEnabled === undefined
        ? normalizeHoldEnabled(project.holdEnabled, false)
        : normalizeHoldEnabled(input.holdEnabled, false),
    reminderMode:
      input.reminderMode === undefined
        ? normalizeReminderMode(project.reminderMode, "backoff")
        : normalizeReminderMode(input.reminderMode, "backoff"),
    updatedAt: new Date().toISOString()
  };
  const paths = getProjectPaths(dataRoot, projectId);
  await repository.writeJson(paths.projectConfigFile, next);
  return next;
}

export async function addAgentToProject(
  dataRoot: string,
  projectId: string,
  agentId: string
): Promise<ProjectRecord> {
  const project = await getProject(dataRoot, projectId);
  const normalizedAgentId = normalizeAgentId(agentId);
  
  if (!normalizedAgentId) {
    return project;
  }

  const existingAgents = project.agentIds ?? [];
  if (existingAgents.includes(normalizedAgentId)) {
    return project;
  }

  const next: ProjectRecord = {
    ...project,
    agentIds: [...existingAgents, normalizedAgentId],
    updatedAt: new Date().toISOString()
  };

  const paths = getProjectPaths(dataRoot, projectId);
  await repository.writeJson(paths.projectConfigFile, next);
  return next;
}

export async function deleteProject(
  dataRoot: string,
  projectIdRaw: string
): Promise<{ projectId: string; removedAt: string }> {
  const projectId = projectIdRaw.trim();
  assertProjectId(projectId);
  const paths = getProjectPaths(dataRoot, projectId);
  try {
    await fs.access(paths.projectRootDir);
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      throw new ProjectStoreError(`project '${projectId}' not found`, "PROJECT_NOT_FOUND");
    }
    throw error;
  }

  await repository.deleteDirectory(paths.projectRootDir);
  return {
    projectId,
    removedAt: new Date().toISOString()
  };
}

async function ensureTeamAgentRequestsFile(
  dataRoot: string,
  projectId: string
): Promise<{ paths: ReturnType<typeof getTeamRequestsPaths>; state: TeamAgentRequestsState }> {
  const paths = getTeamRequestsPaths(dataRoot, projectId);
  await repository.ensureDirectory(path.dirname(paths.teamAgentRequestsFile));
  
  const fallback: TeamAgentRequestsState = {
    schemaVersion: "1.0",
    projectId,
    updatedAt: new Date().toISOString(),
    requests: []
  };
  
  const state = await repository.readJson<TeamAgentRequestsState | null>(paths.teamAgentRequestsFile, fallback);
  if (!state) {
    await repository.writeJson(paths.teamAgentRequestsFile, fallback);
    return { paths, state: fallback };
  }
  return { paths, state };
}

async function ensureRouteChangeRequestsFile(
  dataRoot: string,
  projectId: string
): Promise<{ paths: ReturnType<typeof getTeamRequestsPaths>; state: RouteChangeRequestsState }> {
  const paths = getTeamRequestsPaths(dataRoot, projectId);
  await repository.ensureDirectory(path.dirname(paths.routeChangeRequestsFile));
  
  const fallback: RouteChangeRequestsState = {
    schemaVersion: "1.0",
    projectId,
    updatedAt: new Date().toISOString(),
    requests: []
  };
  
  const state = await repository.readJson<RouteChangeRequestsState | null>(paths.routeChangeRequestsFile, fallback);
  if (!state) {
    await repository.writeJson(paths.routeChangeRequestsFile, fallback);
    return { paths, state: fallback };
  }
  return { paths, state };
}

export async function createTeamAgentRequest(
  dataRoot: string,
  projectId: string,
  input: {
    fromAgent: string;
    fromSessionId: string;
    agentId: string;
    displayName: string;
    prompt: string;
  }
): Promise<TeamAgentRequestsState["requests"][0]> {
  assertProjectId(projectId);
  const { paths, state } = await ensureTeamAgentRequestsFile(dataRoot, projectId);
  const now = new Date().toISOString();
  
  const request: TeamAgentRequestsState["requests"][0] = {
    requestId: randomUUID(),
    fromAgent: input.fromAgent.trim(),
    fromSessionId: input.fromSessionId.trim(),
    agentId: input.agentId.trim(),
    displayName: input.displayName.trim(),
    prompt: input.prompt,
    status: "pending",
    createdAt: now,
    updatedAt: now
  };
  
  state.requests.push(request);
  state.updatedAt = now;
  
  await repository.writeJson(paths.teamAgentRequestsFile, state);
  return request;
}

export async function listTeamAgentRequests(
  dataRoot: string,
  projectId: string
): Promise<TeamAgentRequestsState["requests"]> {
  assertProjectId(projectId);
  const { state } = await ensureTeamAgentRequestsFile(dataRoot, projectId);
  return [...state.requests];
}

export async function updateTeamAgentRequestStatus(
  dataRoot: string,
  projectId: string,
  requestId: string,
  status: "approved" | "rejected"
): Promise<TeamAgentRequestsState["requests"][0] | null> {
  assertProjectId(projectId);
  const { paths, state } = await ensureTeamAgentRequestsFile(dataRoot, projectId);
  const index = state.requests.findIndex((r) => r.requestId === requestId);
  
  if (index === -1) {
    return null;
  }
  
  state.requests[index].status = status;
  state.requests[index].updatedAt = new Date().toISOString();
  state.updatedAt = state.requests[index].updatedAt;
  
  await repository.writeJson(paths.teamAgentRequestsFile, state);
  return state.requests[index];
}

export async function createRouteChangeRequest(
  dataRoot: string,
  projectId: string,
  input: {
    fromAgent: string;
    fromSessionId: string;
    routeTable: Record<string, string[]>;
    agentIds?: string[];
  }
): Promise<RouteChangeRequestsState["requests"][0]> {
  assertProjectId(projectId);
  const { paths, state } = await ensureRouteChangeRequestsFile(dataRoot, projectId);
  const now = new Date().toISOString();
  
  const request: RouteChangeRequestsState["requests"][0] = {
    requestId: randomUUID(),
    fromAgent: input.fromAgent.trim(),
    fromSessionId: input.fromSessionId.trim(),
    routeTable: input.routeTable,
    agentIds: input.agentIds ? normalizeAgentIds(input.agentIds) : undefined,
    status: "pending",
    createdAt: now,
    updatedAt: now
  };
  
  state.requests.push(request);
  state.updatedAt = now;
  
  await repository.writeJson(paths.routeChangeRequestsFile, state);
  return request;
}

export async function listRouteChangeRequests(
  dataRoot: string,
  projectId: string
): Promise<RouteChangeRequestsState["requests"]> {
  assertProjectId(projectId);
  const { state } = await ensureRouteChangeRequestsFile(dataRoot, projectId);
  return [...state.requests];
}

export async function updateRouteChangeRequestStatus(
  dataRoot: string,
  projectId: string,
  requestId: string,
  status: "approved" | "rejected"
): Promise<RouteChangeRequestsState["requests"][0] | null> {
  assertProjectId(projectId);
  const { paths, state } = await ensureRouteChangeRequestsFile(dataRoot, projectId);
  const index = state.requests.findIndex((r) => r.requestId === requestId);
  
  if (index === -1) {
    return null;
  }
  
  state.requests[index].status = status;
  state.requests[index].updatedAt = new Date().toISOString();
  state.updatedAt = state.requests[index].updatedAt;
  
  await repository.writeJson(paths.routeChangeRequestsFile, state);
  return state.requests[index];
}

export type ProjectOverviewRecord = Awaited<ReturnType<typeof getProjectOverview>>;
export type UpdateProjectRoutingInput = Parameters<typeof updateProjectRouting>[2];
export type UpdateProjectOrchestratorSettingsInput = Parameters<typeof updateProjectOrchestratorSettings>[2];
export type RoleReminderUpdates = Partial<Omit<RoleReminderState, "role">>;

export interface ProjectRuntimeRepository {
  getProjectPaths(projectId: string): ProjectPaths;
  ensureProjectRuntime(projectId: string): Promise<ProjectPaths>;
  createProject(input: CreateProjectInput): Promise<{ project: ProjectRecord; paths: ProjectPaths }>;
  getProject(projectId: string): Promise<ProjectRecord>;
  getProjectOverview(projectId: string): Promise<ProjectOverviewRecord>;
  listProjects(): Promise<ProjectSummary[]>;
  updateProjectRouting(projectId: string, input: UpdateProjectRoutingInput): Promise<ProjectRecord>;
  updateTaskAssignRouting(projectId: string, taskAssignRouteTable: Record<string, string[]>): Promise<ProjectRecord>;
  updateProjectOrchestratorSettings(projectId: string, input: UpdateProjectOrchestratorSettingsInput): Promise<ProjectRecord>;
  isProjectRouteAllowed(project: ProjectRecord, fromRole: string, toRole: string): boolean;
  isTaskAssignRouteAllowed(project: ProjectRecord, fromRole: string, toRole: string): boolean;
  resolveSessionByRole(project: ProjectRecord, role?: string): string | undefined;
  setRoleSessionMapping(projectId: string, role: string, sessionId: string): Promise<ProjectRecord>;
  clearRoleSessionMapping(projectId: string, role: string): Promise<ProjectRecord>;
  getRoleReminderState(paths: ProjectPaths, projectId: string, role: string): Promise<RoleReminderState | null>;
  updateRoleReminderState(
    paths: ProjectPaths,
    projectId: string,
    role: string,
    updates: RoleReminderUpdates
  ): Promise<RoleReminderState>;
  deleteProject(projectId: string): Promise<{ projectId: string; removedAt: string }>;
}

class DefaultProjectRuntimeRepository implements ProjectRuntimeRepository {
  constructor(private readonly dataRoot: string) {}

  getProjectPaths(projectId: string): ProjectPaths {
    return getProjectPaths(this.dataRoot, projectId);
  }

  ensureProjectRuntime(projectId: string): Promise<ProjectPaths> {
    return ensureProjectRuntime(this.dataRoot, projectId);
  }

  createProject(input: CreateProjectInput): Promise<{ project: ProjectRecord; paths: ProjectPaths }> {
    return createProject(this.dataRoot, input);
  }

  getProject(projectId: string): Promise<ProjectRecord> {
    return getProject(this.dataRoot, projectId);
  }

  getProjectOverview(projectId: string): Promise<ProjectOverviewRecord> {
    return getProjectOverview(this.dataRoot, projectId);
  }

  listProjects(): Promise<ProjectSummary[]> {
    return listProjects(this.dataRoot);
  }

  updateProjectRouting(projectId: string, input: UpdateProjectRoutingInput): Promise<ProjectRecord> {
    return updateProjectRouting(this.dataRoot, projectId, input);
  }

  updateTaskAssignRouting(projectId: string, taskAssignRouteTable: Record<string, string[]>): Promise<ProjectRecord> {
    return updateTaskAssignRouting(this.dataRoot, projectId, taskAssignRouteTable);
  }

  updateProjectOrchestratorSettings(
    projectId: string,
    input: UpdateProjectOrchestratorSettingsInput
  ): Promise<ProjectRecord> {
    return updateProjectOrchestratorSettings(this.dataRoot, projectId, input);
  }

  isProjectRouteAllowed(project: ProjectRecord, fromRole: string, toRole: string): boolean {
    return isProjectRouteAllowed(project, fromRole, toRole);
  }

  isTaskAssignRouteAllowed(project: ProjectRecord, fromRole: string, toRole: string): boolean {
    return isTaskAssignRouteAllowed(project, fromRole, toRole);
  }

  resolveSessionByRole(project: ProjectRecord, role?: string): string | undefined {
    return resolveSessionByRole(project, role);
  }

  setRoleSessionMapping(projectId: string, role: string, sessionId: string): Promise<ProjectRecord> {
    return setRoleSessionMapping(this.dataRoot, projectId, role, sessionId);
  }

  clearRoleSessionMapping(projectId: string, role: string): Promise<ProjectRecord> {
    return clearRoleSessionMapping(this.dataRoot, projectId, role);
  }

  getRoleReminderState(paths: ProjectPaths, projectId: string, role: string): Promise<RoleReminderState | null> {
    return getRoleReminderState(paths, projectId, role);
  }

  updateRoleReminderState(
    paths: ProjectPaths,
    projectId: string,
    role: string,
    updates: RoleReminderUpdates
  ): Promise<RoleReminderState> {
    return updateRoleReminderState(paths, projectId, role, updates);
  }

  deleteProject(projectId: string): Promise<{ projectId: string; removedAt: string }> {
    return deleteProject(this.dataRoot, projectId);
  }
}

export function createProjectRuntimeRepository(dataRoot: string): ProjectRuntimeRepository {
  return new DefaultProjectRuntimeRepository(dataRoot);
}
