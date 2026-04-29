import type { EventRecord } from "@/types/project";
import { API_BASE, fetchText } from "./shared/http";
import { mapEventFields } from "./project-mappers";

export const projectEventsApi = {
  getEvents: async (projectId: string, since?: string): Promise<EventRecord[]> => {
    const url = since
      ? `${API_BASE}/projects/${encodeURIComponent(projectId)}/events?since=${encodeURIComponent(since)}`
      : `${API_BASE}/projects/${encodeURIComponent(projectId)}/events`;
    const text = await fetchText(url);
    const lines = text.split("\n").filter((line) => line.trim());
    return lines.map((line) => mapEventFields(JSON.parse(line)));
  }
};
