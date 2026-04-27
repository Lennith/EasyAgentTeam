import type {
  AgentDefinition,
  AgentTemplateDefinition,
  SkillDefinition,
  SkillImportResult,
  SkillListDefinition
} from "@/types";
import { API_BASE, fetchJSON } from "./shared/http";
import { mapSkillDefinition, mapSkillListDefinition } from "./shared/mappers";

export const agentApi = {
  list: async () => {
    const data = await fetchJSON<{
      builtInItems?: Record<string, unknown>[];
      customItems?: Record<string, unknown>[];
      items?: Record<string, unknown>[];
    }>(`${API_BASE}/agents`);
    const agents: AgentDefinition[] = [];

    if (data.items) {
      agents.push(
        ...data.items.map((raw) => ({
          agentId: (raw.agentId ?? raw.agent_id) as string,
          displayName: (raw.displayName ?? raw.display_name) as string,
          prompt: raw.prompt as string,
          summary: raw.summary as string | undefined,
          skillList: (raw.skillList ?? raw.skill_list ?? []) as string[],
          updatedAt: (raw.updatedAt ?? raw.updated_at) as string,
          defaultCliTool: (raw.defaultCliTool ?? raw.default_cli_tool ?? raw.provider_id ?? raw.providerId) as
            | "codex"
            | "minimax"
            | undefined,
          defaultModelParams: raw.defaultModelParams as Record<string, unknown> | undefined,
          modelSelectionEnabled: raw.modelSelectionEnabled as boolean | undefined,
          createdAt: (raw.createdAt ?? raw.created_at) as string | undefined
        }))
      );
    }

    if (data.builtInItems) {
      agents.push(
        ...data.builtInItems.map((raw) => ({
          agentId: (raw.agentId ?? raw.agent_id) as string,
          displayName: (raw.displayName ?? raw.display_name) as string,
          prompt: raw.prompt as string,
          summary: raw.summary as string | undefined,
          skillList: (raw.skillList ?? raw.skill_list ?? []) as string[],
          updatedAt: (raw.updatedAt ?? raw.updated_at ?? new Date().toISOString()) as string,
          defaultCliTool: (raw.defaultCliTool ?? raw.default_cli_tool ?? raw.provider_id ?? raw.providerId) as
            | "codex"
            | "minimax"
            | undefined,
          defaultModelParams: raw.defaultModelParams as Record<string, unknown> | undefined,
          modelSelectionEnabled: raw.modelSelectionEnabled as boolean | undefined
        }))
      );
    }

    if (data.customItems) {
      agents.push(
        ...data.customItems.map((raw) => ({
          agentId: (raw.agentId ?? raw.agent_id) as string,
          displayName: (raw.displayName ?? raw.display_name) as string,
          prompt: raw.prompt as string,
          summary: raw.summary as string | undefined,
          skillList: (raw.skillList ?? raw.skill_list ?? []) as string[],
          updatedAt: (raw.updatedAt ?? raw.updated_at ?? new Date().toISOString()) as string,
          defaultCliTool: (raw.defaultCliTool ?? raw.default_cli_tool ?? raw.provider_id ?? raw.providerId) as
            | "codex"
            | "minimax"
            | undefined,
          defaultModelParams: raw.defaultModelParams as Record<string, unknown> | undefined,
          modelSelectionEnabled: raw.modelSelectionEnabled as boolean | undefined
        }))
      );
    }

    return { items: agents };
  },

  create: (data: {
    agent_id: string;
    display_name: string;
    prompt: string;
    summary?: string;
    skill_list?: string[];
    provider_id?: "codex" | "minimax";
  }) =>
    fetchJSON<{ agentId: string }>(`${API_BASE}/agents`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  update: (
    agentId: string,
    data: {
      display_name?: string;
      prompt?: string;
      summary?: string | null;
      skill_list?: string[];
      provider_id?: "codex" | "minimax";
    }
  ) =>
    fetchJSON<{ agentId: string }>(`${API_BASE}/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

  delete: (agentId: string) =>
    fetchJSON<{ success: boolean }>(`${API_BASE}/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE"
    })
};

export const skillApi = {
  list: async (): Promise<{ items: SkillDefinition[]; total: number }> => {
    const data = await fetchJSON<{ items?: Record<string, unknown>[]; total?: number }>(`${API_BASE}/skills`);
    const items = (data.items ?? []).map(mapSkillDefinition);
    return { items, total: data.total ?? items.length };
  },

  import: async (data: { sources: string[]; recursive?: boolean }): Promise<SkillImportResult> => {
    const payload = await fetchJSON<{
      imported?: Array<{ skill: Record<string, unknown>; action: "created" | "updated"; warnings?: string[] }>;
      warnings?: string[];
    }>(`${API_BASE}/skills/import`, {
      method: "POST",
      body: JSON.stringify(data)
    });
    return {
      imported: (payload.imported ?? []).map((item) => ({
        skill: mapSkillDefinition(item.skill),
        action: item.action,
        warnings: item.warnings ?? []
      })),
      warnings: payload.warnings ?? []
    };
  },

  delete: (skillId: string) =>
    fetchJSON<SkillDefinition>(`${API_BASE}/skills/${encodeURIComponent(skillId)}`, {
      method: "DELETE"
    })
};

export const skillListApi = {
  list: async (): Promise<{ items: SkillListDefinition[]; total: number }> => {
    const data = await fetchJSON<{ items?: Record<string, unknown>[]; total?: number }>(`${API_BASE}/skill-lists`);
    const items = (data.items ?? []).map(mapSkillListDefinition);
    return { items, total: data.total ?? items.length };
  },

  create: async (data: {
    list_id: string;
    display_name?: string;
    description?: string;
    include_all?: boolean;
    skill_ids?: string[];
  }): Promise<SkillListDefinition> => {
    const payload = await fetchJSON<Record<string, unknown>>(`${API_BASE}/skill-lists`, {
      method: "POST",
      body: JSON.stringify(data)
    });
    return mapSkillListDefinition(payload);
  },

  update: async (
    listId: string,
    data: {
      display_name?: string;
      description?: string | null;
      include_all?: boolean;
      skill_ids?: string[];
    }
  ): Promise<SkillListDefinition> => {
    const payload = await fetchJSON<Record<string, unknown>>(`${API_BASE}/skill-lists/${encodeURIComponent(listId)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    });
    return mapSkillListDefinition(payload);
  },

  delete: (listId: string) =>
    fetchJSON<SkillListDefinition>(`${API_BASE}/skill-lists/${encodeURIComponent(listId)}`, {
      method: "DELETE"
    })
};

export const templateApi = {
  list: () =>
    fetchJSON<{ builtInItems?: AgentTemplateDefinition[]; customItems?: AgentTemplateDefinition[] }>(
      `${API_BASE}/agent-templates`
    ),

  create: (data: { template_id: string; display_name: string; prompt: string; based_on_template_id?: string | null }) =>
    fetchJSON<{ templateId: string }>(`${API_BASE}/agent-templates`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  update: (templateId: string, data: { display_name?: string; prompt?: string }) =>
    fetchJSON<{ templateId: string }>(`${API_BASE}/agent-templates/${encodeURIComponent(templateId)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

  delete: (templateId: string) =>
    fetchJSON<{ success: boolean }>(`${API_BASE}/agent-templates/${encodeURIComponent(templateId)}`, {
      method: "DELETE"
    })
};
