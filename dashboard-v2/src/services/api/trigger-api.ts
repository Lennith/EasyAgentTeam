import type {
  TriggerConfigRecord,
  TriggerExecutionResult,
  TriggerPluginRecord,
  TriggerRunHistoryItem,
  TriggerSessionBindingRecord
} from "@/types/workflow";
import { API_BASE, fetchJSON } from "./shared/http";

export const triggerApi = {
  listPlugins: () => fetchJSON<{ items: TriggerPluginRecord[]; total: number }>(`${API_BASE}/trigger-plugins`),

  importPlugin: (data: { source: string }) =>
    fetchJSON<{ plugin: TriggerPluginRecord }>(`${API_BASE}/trigger-plugins/import`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  listTriggers: () => fetchJSON<{ items: TriggerConfigRecord[]; total: number }>(`${API_BASE}/triggers`),

  createTrigger: (data: {
    trigger_id: string;
    plugin_id: string;
    enabled: boolean;
    interval_seconds: number;
    workflow_template_id: string;
    workspace_path: string;
    default_variables?: Record<string, string>;
    hook_timeout_ms?: number;
    session_mode?: "fresh" | "reuse_provider_session";
  }) =>
    fetchJSON<TriggerConfigRecord>(`${API_BASE}/triggers`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  patchTrigger: (
    triggerId: string,
    data: Partial<{
      plugin_id: string;
      enabled: boolean;
      interval_seconds: number;
      workflow_template_id: string;
      workspace_path: string;
      default_variables: Record<string, string> | null;
      hook_timeout_ms: number;
      session_mode: "fresh" | "reuse_provider_session";
    }>
  ) =>
    fetchJSON<TriggerConfigRecord>(`${API_BASE}/triggers/${encodeURIComponent(triggerId)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

  deleteTrigger: (triggerId: string) =>
    fetchJSON<TriggerConfigRecord>(`${API_BASE}/triggers/${encodeURIComponent(triggerId)}`, {
      method: "DELETE"
    }),

  testTrigger: (triggerId: string) =>
    fetchJSON<TriggerExecutionResult>(`${API_BASE}/triggers/${encodeURIComponent(triggerId)}/test`, {
      method: "POST"
    }),

  listTriggerRuns: (triggerId: string) =>
    fetchJSON<{ items: TriggerRunHistoryItem[]; total: number }>(
      `${API_BASE}/triggers/${encodeURIComponent(triggerId)}/runs`
    ),

  listTriggerSessionBindings: (triggerId: string) =>
    fetchJSON<{ items: TriggerSessionBindingRecord[]; total: number }>(
      `${API_BASE}/triggers/${encodeURIComponent(triggerId)}/session-bindings`
    ),

  resetTriggerSessionBindings: (triggerId: string, data: { role?: string; provider?: string } = {}) =>
    fetchJSON<{ removed: TriggerSessionBindingRecord[]; removedCount: number }>(
      `${API_BASE}/triggers/${encodeURIComponent(triggerId)}/session-bindings/reset`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    )
};
