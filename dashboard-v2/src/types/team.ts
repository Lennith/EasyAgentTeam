import type { AgentModelConfig } from "./catalog";
import type { CatalogTeamCreatePublicRequest, CatalogTeamUpdatePublicRequest } from "@autodev/agent-library";

export type TeamView = "list" | "edit" | "new";

export interface TeamRecord {
  schemaVersion: "1.0";
  teamId: string;
  name: string;
  description?: string;
  agentIds: string[];
  routeTable: Record<string, string[]>;
  taskAssignRouteTable: Record<string, string[]>;
  routeDiscussRounds: Record<string, Record<string, number>>;
  agentModelConfigs: Record<string, AgentModelConfig>;
  createdAt: string;
  updatedAt: string;
}

export interface TeamSummary {
  teamId: string;
  name: string;
  description?: string;
  agentCount: number;
  createdAt: string;
  updatedAt: string;
}

export type CreateTeamRequest = CatalogTeamCreatePublicRequest;
export type UpdateTeamRequest = CatalogTeamUpdatePublicRequest;
