export interface AgentModelConfig {
  tool: "codex" | "trae" | "minimax";
  model: string;
  effort?: "low" | "medium" | "high";
}

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

export interface CreateTeamInput {
  teamId: string;
  name: string;
  description?: string;
  agentIds?: string[];
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  agentModelConfigs?: Record<string, AgentModelConfig>;
}

export interface UpdateTeamInput {
  name?: string;
  description?: string;
  agentIds?: string[];
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  agentModelConfigs?: Record<string, AgentModelConfig>;
}
