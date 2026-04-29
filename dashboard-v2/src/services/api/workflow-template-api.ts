import type { WorkflowTemplateRecord } from "@/types/workflow";
import { API_BASE, fetchJSON } from "./shared/http";

type WorkflowTemplateTaskInput = {
  task_id: string;
  title: string;
  owner_role: string;
  parent_task_id?: string;
  dependencies?: string[];
  write_set?: string[];
  acceptance?: string[];
  artifacts?: string[];
};

export const workflowTemplateApi = {
  listTemplates: () => fetchJSON<{ items: WorkflowTemplateRecord[]; total: number }>(`${API_BASE}/workflow-templates`),

  getTemplate: (templateId: string) =>
    fetchJSON<WorkflowTemplateRecord>(`${API_BASE}/workflow-templates/${encodeURIComponent(templateId)}`),

  createTemplate: (data: {
    template_id: string;
    name: string;
    description?: string;
    tasks: WorkflowTemplateTaskInput[];
    route_table?: Record<string, string[]>;
    task_assign_route_table?: Record<string, string[]>;
    route_discuss_rounds?: Record<string, Record<string, number>>;
    default_variables?: Record<string, string>;
  }) =>
    fetchJSON<WorkflowTemplateRecord>(`${API_BASE}/workflow-templates`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  patchTemplate: (
    templateId: string,
    data: {
      name?: string;
      description?: string | null;
      tasks?: WorkflowTemplateTaskInput[];
      route_table?: Record<string, string[]>;
      task_assign_route_table?: Record<string, string[]>;
      route_discuss_rounds?: Record<string, Record<string, number>>;
      default_variables?: Record<string, string>;
    }
  ) =>
    fetchJSON<WorkflowTemplateRecord>(`${API_BASE}/workflow-templates/${encodeURIComponent(templateId)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

  deleteTemplate: (templateId: string) =>
    fetchJSON<{ templateId: string; removedAt: string }>(
      `${API_BASE}/workflow-templates/${encodeURIComponent(templateId)}`,
      {
        method: "DELETE"
      }
    )
};
