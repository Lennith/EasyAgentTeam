import type { TemplateDefinition } from "@/types/catalog";
import { API_BASE, fetchJSON } from "./shared/http";

export const projectTemplateApi = {
  list: () => fetchJSON<{ items: TemplateDefinition[] }>(`${API_BASE}/project-templates`)
};
