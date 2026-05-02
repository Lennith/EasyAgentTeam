import type { AgentModelConfig } from "./catalog";

export interface RoutingConfigRequest {
  agent_ids?: string[];
  route_table?: Record<string, string[]>;
  route_discuss_rounds?: Record<string, Record<string, number>>;
  agent_model_configs?: Record<string, AgentModelConfig>;
}
