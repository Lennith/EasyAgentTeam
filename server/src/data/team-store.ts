import * as path from "path";
import * as fs from "fs";
import { readJsonFile, writeJsonFile, ensureDirectory } from "./file-utils.js";
import type { TeamRecord, TeamSummary, CreateTeamInput, UpdateTeamInput } from "../domain/team-models.js";

const TEAMS_DIR = "teams";

function teamsDir(dataRoot: string): string {
  return path.join(dataRoot, TEAMS_DIR);
}

function teamFile(dataRoot: string, teamId: string): string {
  return path.join(teamsDir(dataRoot), `${teamId}.json`);
}

function normalizeTeamId(teamId: string): string {
  return teamId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

export async function listTeams(dataRoot: string): Promise<TeamSummary[]> {
  const dir = teamsDir(dataRoot);
  try {
    await fs.promises.access(dir);
  } catch {
    return [];
  }

  const files = await fs.promises.readdir(dir);
  const teams: TeamSummary[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(dir, file);
    try {
      const team = await readJsonFile<TeamRecord>(filePath, {} as TeamRecord);
      if (team && team.teamId) {
        teams.push({
          teamId: team.teamId,
          name: team.name,
          description: team.description,
          agentCount: team.agentIds?.length ?? 0,
          createdAt: team.createdAt,
          updatedAt: team.updatedAt,
        });
      }
    } catch {
      continue;
    }
  }

  return teams.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTeam(dataRoot: string, teamId: string): Promise<TeamRecord | null> {
  const normalized = normalizeTeamId(teamId);
  const filePath = teamFile(dataRoot, normalized);
  try {
    const team = await readJsonFile<TeamRecord>(filePath, null as unknown as TeamRecord);
    if (team && typeof team === 'object' && 'teamId' in team) {
      return team;
    }
    return null;
  } catch {
    return null;
  }
}

export async function createTeam(
  dataRoot: string,
  input: CreateTeamInput
): Promise<TeamRecord> {
  const normalized = normalizeTeamId(input.teamId);
  const filePath = teamFile(dataRoot, normalized);

  const existing = await getTeam(dataRoot, normalized);
  if (existing) {
    throw new Error(`Team '${normalized}' already exists`);
  }

  const now = new Date().toISOString();
  const team: TeamRecord = {
    schemaVersion: "1.0",
    teamId: normalized,
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    agentIds: input.agentIds ?? [],
    routeTable: input.routeTable ?? {},
    taskAssignRouteTable: input.taskAssignRouteTable ?? {},
    routeDiscussRounds: input.routeDiscussRounds ?? {},
    agentModelConfigs: input.agentModelConfigs ?? {},
    createdAt: now,
    updatedAt: now,
  };

  await writeJsonFile(filePath, team);
  return team;
}

export async function updateTeam(
  dataRoot: string,
  teamId: string,
  input: UpdateTeamInput
): Promise<TeamRecord> {
  const normalized = normalizeTeamId(teamId);
  const filePath = teamFile(dataRoot, normalized);

  const existing = await getTeam(dataRoot, normalized);
  if (!existing) {
    throw new Error(`Team '${normalized}' not found`);
  }

  const now = new Date().toISOString();
  const updated: TeamRecord = {
    ...existing,
    name: input.name?.trim() ?? existing.name,
    description: input.description?.trim() || undefined,
    agentIds: input.agentIds ?? existing.agentIds,
    routeTable: input.routeTable ?? existing.routeTable,
    taskAssignRouteTable: input.taskAssignRouteTable ?? existing.taskAssignRouteTable,
    routeDiscussRounds: input.routeDiscussRounds ?? existing.routeDiscussRounds,
    agentModelConfigs: input.agentModelConfigs ?? existing.agentModelConfigs,
    updatedAt: now,
  };

  await writeJsonFile(filePath, updated);
  return updated;
}

export async function deleteTeam(dataRoot: string, teamId: string): Promise<boolean> {
  const normalized = normalizeTeamId(teamId);
  const filePath = teamFile(dataRoot, normalized);

  try {
    await fs.promises.access(filePath);
    await fs.promises.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureTeamsDir(dataRoot: string): Promise<void> {
  await ensureDirectory(teamsDir(dataRoot));
}
