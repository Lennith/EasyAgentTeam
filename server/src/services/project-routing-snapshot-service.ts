import type { ProjectRecord } from "../domain/models.js";
import { resolveDiscussRoundLimit } from "./discuss-policy-service.js";

export interface RouteTargetDescriptor {
  agentId: string;
  maxDiscussRounds: number;
}

export interface ProjectRoutingSnapshot {
  projectId: string;
  fromAgent: string;
  fromAgentEnabled: boolean;
  enabledAgents: string[];
  hasExplicitRouteTable: boolean;
  allowedTargets: RouteTargetDescriptor[];
}

function normalizeAgentId(raw: string): string {
  return raw.trim();
}

function uniq(items: string[]): string[] {
  return Array.from(new Set(items));
}

function resolveEnabledAgents(project: ProjectRecord, allRegisteredAgentIds: string[]): string[] {
  const fromProject = (project.agentIds ?? []).map(normalizeAgentId).filter((item) => item.length > 0);
  if (fromProject.length > 0) {
    return uniq(fromProject);
  }
  return uniq(allRegisteredAgentIds.map(normalizeAgentId).filter((item) => item.length > 0));
}

export function buildProjectRoutingSnapshot(
  project: ProjectRecord,
  fromAgentRaw: string,
  allRegisteredAgentIds: string[]
): ProjectRoutingSnapshot {
  const fromAgent = normalizeAgentId(fromAgentRaw);
  const enabledAgents = resolveEnabledAgents(project, allRegisteredAgentIds);
  const enabledSet = new Set(enabledAgents);
  const fromAgentEnabled = enabledSet.has(fromAgent);
  const hasExplicitRouteTable = !!project.routeTable && Object.keys(project.routeTable).length > 0;
  const explicitTargets = hasExplicitRouteTable ? (project.routeTable?.[fromAgent] ?? []) : [];
  const allowedTargetIds = hasExplicitRouteTable
    ? uniq(explicitTargets.map(normalizeAgentId).filter((item) => item.length > 0)).filter((item) =>
        enabledSet.has(item)
      )
    : enabledAgents.filter((item) => item !== fromAgent);

  const allowedTargets = allowedTargetIds.map((agentId) => ({
    agentId,
    maxDiscussRounds: resolveDiscussRoundLimit(project, fromAgent, agentId)
  }));

  return {
    projectId: project.projectId,
    fromAgent,
    fromAgentEnabled,
    enabledAgents,
    hasExplicitRouteTable,
    allowedTargets
  };
}
