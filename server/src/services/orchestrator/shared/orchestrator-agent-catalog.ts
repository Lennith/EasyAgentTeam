export interface OrchestratorAgentCatalogEntry {
  agentId: string;
  prompt: string;
  summary?: string | null;
}

export interface OrchestratorAgentCatalog {
  agentIds: string[];
  rolePromptMap: Map<string, string>;
  roleSummaryMap: Map<string, string>;
}

export function buildOrchestratorAgentCatalog(
  agents: ReadonlyArray<OrchestratorAgentCatalogEntry>
): OrchestratorAgentCatalog {
  return {
    agentIds: agents.map((item) => item.agentId),
    rolePromptMap: new Map(agents.map((item) => [item.agentId, item.prompt])),
    roleSummaryMap: new Map(agents.map((item) => [item.agentId, item.summary ?? ""]))
  };
}
