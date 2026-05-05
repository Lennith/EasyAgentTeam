import type { WorkflowTemplateRecord } from "@/types/workflow";
import type { WorkflowTemplatePatchPublicPayload, WorkflowTemplatePublicPayload } from "@autodev/agent-library";
import { API_BASE, fetchJSON } from "./shared/http";

export const workflowTemplateApi = {
  listTemplates: () => fetchJSON<{ items: WorkflowTemplateRecord[]; total: number }>(`${API_BASE}/workflow-templates`),

  getTemplate: (templateId: string) =>
    fetchJSON<WorkflowTemplateRecord>(`${API_BASE}/workflow-templates/${encodeURIComponent(templateId)}`),

  createTemplate: (data: WorkflowTemplatePublicPayload) =>
    fetchJSON<WorkflowTemplateRecord>(`${API_BASE}/workflow-templates`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  patchTemplate: (templateId: string, data: WorkflowTemplatePatchPublicPayload) =>
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
