import type {
  AgentIOTimelineItem,
  CreateProjectRequest,
  DispatchResult,
  EventRecord,
  LockRecord,
  OrchestratorSettings,
  ProjectDetail,
  ProjectSummary,
  RoutingConfigRequest,
  RuntimeRecoveryAttemptsResponse,
  RuntimeRecoveryItem,
  RuntimeRecoveryResponse,
  SendMessageRequest,
  SessionRecord,
  TaskActionRequest,
  TaskDetail,
  TaskPatchRequest,
  TaskTreeNode,
  TaskTreeResponse,
  TemplateDefinition
} from "@/types";
import { API_BASE, RECOVERY_CENTER_ATTEMPT_LIMIT, fetchJSON, fetchText } from "./shared/http";
import {
  buildRetryDispatchGuardBody,
  mapEventFields,
  mapRuntimeRecoveryAttemptsResponse,
  mapRuntimeRecoveryResponse,
  mapSessionFields,
  normalizeTaskDetail,
  normalizeTaskTreeNode,
  normalizeTaskTreeResponse
} from "./shared/mappers";

export const projectApi = {
  list: () => fetchJSON<{ items: ProjectSummary[] }>(`${API_BASE}/projects`),

  get: (projectId: string) => fetchJSON<ProjectDetail>(`${API_BASE}/projects/${encodeURIComponent(projectId)}`),

  create: (data: CreateProjectRequest) =>
    fetchJSON<{ projectId: string }>(`${API_BASE}/projects`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  delete: (projectId: string) =>
    fetchJSON<{ success: boolean }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE"
    }),

  getEvents: async (projectId: string, since?: string): Promise<EventRecord[]> => {
    const url = since
      ? `${API_BASE}/projects/${encodeURIComponent(projectId)}/events?since=${encodeURIComponent(since)}`
      : `${API_BASE}/projects/${encodeURIComponent(projectId)}/events`;
    const text = await fetchText(url);
    const lines = text.split("\n").filter((line) => line.trim());
    return lines.map((line) => mapEventFields(JSON.parse(line)));
  },

  getSessions: async (projectId: string): Promise<{ items: SessionRecord[] }> => {
    const data = await fetchJSON<{ items: Record<string, unknown>[] }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions`
    );
    return { items: (data.items ?? []).map(mapSessionFields) };
  },

  getRuntimeRecovery: async (projectId: string): Promise<RuntimeRecoveryResponse> =>
    mapRuntimeRecoveryResponse(
      await fetchJSON<Record<string, unknown>>(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}/runtime-recovery?attempt_limit=${RECOVERY_CENTER_ATTEMPT_LIMIT}`
      )
    ),

  getSessionRecoveryAttempts: async (
    projectId: string,
    sessionId: string,
    attemptLimit: number | "all" = "all"
  ): Promise<RuntimeRecoveryAttemptsResponse> =>
    mapRuntimeRecoveryAttemptsResponse(
      await fetchJSON<Record<string, unknown>>(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/recovery-attempts?attempt_limit=${encodeURIComponent(String(attemptLimit))}`
      )
    ),

  getTaskTree: (
    projectId: string,
    options?: {
      focus_task_id?: string;
      max_descendant_depth?: number;
      include_external_dependencies?: boolean;
    }
  ) => {
    const params = new URLSearchParams();
    if (options?.focus_task_id) params.set("focus_task_id", options.focus_task_id);
    if (options?.max_descendant_depth) params.set("max_descendant_depth", String(options.max_descendant_depth));
    if (options?.include_external_dependencies !== undefined) {
      params.set("include_external_dependencies", String(options.include_external_dependencies));
    }
    const query = params.toString();
    const url = `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-tree${query ? `?${query}` : ""}`;
    return fetchJSON<TaskTreeResponse>(url).then(normalizeTaskTreeResponse);
  },

  getTaskDetail: (projectId: string, taskId: string) =>
    fetchJSON<TaskDetail>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/detail`
    ).then(normalizeTaskDetail),

  taskAction: (projectId: string, data: TaskActionRequest) =>
    fetchJSON<{ taskId?: string; success: boolean }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-actions`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    ),

  patchTask: (projectId: string, taskId: string, data: TaskPatchRequest) =>
    fetchJSON<{ success: boolean; task: TaskTreeNode }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(data)
      }
    ).then((payload) => ({
      ...payload,
      task: normalizeTaskTreeNode(payload.task)
    })),

  getLocks: (projectId: string) =>
    fetchJSON<{ items: LockRecord[] }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/locks`),

  acquireLock: (
    projectId: string,
    data: { session_id: string; target_type: "file" | "dir"; lock_key: string; ttl_seconds: number; purpose?: string }
  ) =>
    fetchJSON<{ result: string }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/locks/acquire`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  renewLock: (projectId: string, data: { session_id: string; lock_key: string }) =>
    fetchJSON<{ result: string }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/locks/renew`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  releaseLock: (projectId: string, data: { session_id: string; lock_key: string }) =>
    fetchJSON<{ result: string }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/locks/release`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  updateRoutingConfig: (projectId: string, data: RoutingConfigRequest) =>
    fetchJSON<ProjectDetail>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/routing-config`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

  getTaskAssignRouting: (projectId: string) =>
    fetchJSON<{ project_id: string; task_assign_route_table: Record<string, string[]>; updated_at: string }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-assign-routing`
    ),

  updateTaskAssignRouting: (projectId: string, taskAssignRouteTable: Record<string, string[]>) =>
    fetchJSON<{ project_id: string; task_assign_route_table: Record<string, string[]>; updated_at: string }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-assign-routing`,
      {
        method: "PATCH",
        body: JSON.stringify({ task_assign_route_table: taskAssignRouteTable })
      }
    ),

  sendMessage: (projectId: string, data: SendMessageRequest) =>
    fetchJSON<{
      requestId: string;
      messageId: string;
      resolvedSessionId: string;
      messageType: string;
      buffered?: boolean;
    }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/messages/send`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  getAgentIOTimeline: async (projectId: string, limit?: number): Promise<{ items: AgentIOTimelineItem[] }> => {
    const url = limit
      ? `${API_BASE}/projects/${encodeURIComponent(projectId)}/agent-io/timeline?limit=${limit}`
      : `${API_BASE}/projects/${encodeURIComponent(projectId)}/agent-io/timeline`;
    try {
      const data = await fetchJSON<{ items: Record<string, unknown>[] }>(url);
      return {
        items: (data.items ?? []).map((raw) => ({
          id: (raw.itemId ?? raw.id ?? raw.ioId) as string,
          projectId: (raw.projectId ?? raw.project_id) as string,
          sessionId: (raw.sessionId ?? raw.session_id ?? raw.toSessionId) as string,
          role: (raw.role ?? raw.from ?? raw.toRole) as string,
          taskId: (raw.taskId ?? raw.task_id) as string | undefined,
          direction: (raw.direction ?? (raw.kind?.toString().includes("report") ? "outbound" : "inbound")) as
            | "inbound"
            | "outbound",
          messageType: (raw.messageType ?? raw.kind ?? raw.message_type) as string,
          summary: (raw.content ?? raw.summary) as string | undefined,
          createdAt: (raw.createdAt ?? raw.created_at) as string,
          from: raw.from as string | undefined,
          toRole: raw.toRole as string | undefined,
          sourceType: raw.sourceType as "user" | "agent" | "manager" | "system" | undefined,
          originAgent: raw.originAgent as string | undefined,
          kind: raw.kind as string | undefined,
          status: raw.status as string | undefined,
          runId: raw.runId as string | undefined
        }))
      };
    } catch {
      return { items: [] };
    }
  },

  dispatch: (
    projectId: string,
    data: { session_id?: string; force?: boolean; only_idle?: boolean; task_id?: string }
  ) =>
    fetchJSON<{ results: DispatchResult[] }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/orchestrator/dispatch`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    ),

  dispatchMessage: (
    projectId: string,
    data: { message_id: string; session_id?: string; force?: boolean; only_idle?: boolean }
  ) =>
    fetchJSON<{ results: DispatchResult[] }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/orchestrator/dispatch-message`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    ),

  dismissSession: (projectId: string, sessionId: string, reason?: string, confirm?: boolean) =>
    fetchJSON<Record<string, unknown>>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/dismiss`,
      {
        method: "POST",
        body: JSON.stringify({
          reason: reason ?? "dashboard_manual_dismiss",
          actor: "dashboard",
          ...(confirm ? { confirm: true } : {})
        })
      }
    ),

  repairSession: (projectId: string, sessionId: string, targetStatus: "idle" | "blocked", confirm?: boolean) =>
    fetchJSON<Record<string, unknown>>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/repair`,
      {
        method: "POST",
        body: JSON.stringify({
          target_status: targetStatus,
          reason: "dashboard_manual_repair",
          actor: "dashboard",
          ...(confirm ? { confirm: true } : {})
        })
      }
    ),

  retryDispatchSession: (projectId: string, item: RuntimeRecoveryItem, confirm?: boolean) =>
    fetchJSON<Record<string, unknown>>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(item.session_id)}/retry-dispatch`,
      {
        method: "POST",
        body: JSON.stringify(buildRetryDispatchGuardBody(item, "dashboard_manual_retry_dispatch", confirm))
      }
    ),

  registerSession: (projectId: string, data: { session_id: string; role: string; status?: string }) =>
    fetchJSON<{ success: boolean }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  getOrchestratorSettings: (projectId: string) =>
    fetchJSON<OrchestratorSettings>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/orchestrator/settings`),

  updateOrchestratorSettings: (
    projectId: string,
    data: {
      auto_dispatch_enabled?: boolean;
      auto_dispatch_remaining?: number;
      hold_enabled?: boolean;
      reminder_mode?: "backoff" | "fixed_interval";
    }
  ) =>
    fetchJSON<{
      project_id: string;
      auto_dispatch_enabled: boolean;
      auto_dispatch_remaining: number;
      hold_enabled: boolean;
      reminder_mode: "backoff" | "fixed_interval";
      updated_at: string;
    }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/orchestrator/settings`, {
      method: "PATCH",
      body: JSON.stringify(data)
    })
};

export const projectTemplateApi = {
  list: () => fetchJSON<{ items: TemplateDefinition[] }>(`${API_BASE}/project-templates`)
};
