import type { AgentModelConfig } from "./catalog";

export interface ProjectSummary {
  projectId: string;
  name: string;
  workspacePath: string;
}

export interface ProjectDetail extends ProjectSummary {
  createdAt?: string;
  updatedAt?: string;
  templateId?: string;
  agentIds?: string[];
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  agentModelConfigs?: Record<string, AgentModelConfig>;
  autoDispatchEnabled?: boolean;
  autoDispatchRemaining?: number;
  holdEnabled?: boolean;
  roleSessionMap?: Record<string, string>;
}

export interface CreateProjectRequest {
  project_id: string;
  name: string;
  workspace_path: string;
  template_id?: string;
  team_id?: string;
  agent_ids?: string[];
  route_table?: Record<string, string[]>;
  route_discuss_rounds?: number;
  role_session_map?: Record<string, string>;
  auto_dispatch_enabled?: boolean;
  auto_dispatch_remaining?: number;
}
