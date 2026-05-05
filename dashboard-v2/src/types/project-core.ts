import type { AgentModelConfig } from "./catalog";
import type { ProjectCreatePublicRequest } from "@autodev/agent-library";

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

export type CreateProjectRequest = ProjectCreatePublicRequest;
