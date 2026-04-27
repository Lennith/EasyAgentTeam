import type { AgentModelConfig } from "./catalog";

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

export interface CreateTeamRequest {
  team_id: string;
  name: string;
  description?: string;
  agent_ids?: string[];
  route_table?: Record<string, string[]>;
  task_assign_route_table?: Record<string, string[]>;
  route_discuss_rounds?: Record<string, Record<string, number>>;
  agent_model_configs?: Record<string, AgentModelConfig>;
}

export interface UpdateTeamRequest {
  name?: string;
  description?: string;
  agent_ids?: string[];
  route_table?: Record<string, string[]>;
  task_assign_route_table?: Record<string, string[]>;
  route_discuss_rounds?: Record<string, Record<string, number>>;
  agent_model_configs?: Record<string, AgentModelConfig>;
}
