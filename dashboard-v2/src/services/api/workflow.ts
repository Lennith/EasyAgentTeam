import type {
  AgentIOTimelineItem,
  RuntimeRecoveryAttemptsResponse,
  RuntimeRecoveryItem,
  RuntimeRecoveryResponse,
  TaskDetail,
  TaskTreeResponse,
  WorkflowOrchestratorStatus,
  WorkflowRunMode,
  WorkflowRunOrchestratorSettings,
  WorkflowRunRecord,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeStatus,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult,
  WorkflowTaskTreeRuntimeResponse,
  WorkflowTemplateRecord
} from "@/types";
import { API_BASE, RECOVERY_CENTER_ATTEMPT_LIMIT, fetchJSON } from "./shared/http";
import {
  buildRetryDispatchGuardBody,
  mapRuntimeRecoveryAttemptsResponse,
  mapRuntimeRecoveryResponse,
  mapWorkflowSessionFields,
  normalizeTaskDetail,
  normalizeTaskTreeResponse,
  normalizeWorkflowRunRecord,
  normalizeWorkflowRunRuntimeSnapshot,
  normalizeWorkflowTaskTreeRuntimeResponse
} from "./shared/mappers";

export const workflowApi = {
  listTemplates: () => fetchJSON<{ items: WorkflowTemplateRecord[]; total: number }>(`${API_BASE}/workflow-templates`),

  getTemplate: (templateId: string) =>
    fetchJSON<WorkflowTemplateRecord>(`${API_BASE}/workflow-templates/${encodeURIComponent(templateId)}`),

  createTemplate: (data: {
    template_id: string;
    name: string;
    description?: string;
    tasks: Array<{
      task_id: string;
      title: string;
      owner_role: string;
      parent_task_id?: string;
      dependencies?: string[];
      write_set?: string[];
      acceptance?: string[];
      artifacts?: string[];
    }>;
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
      tasks?: Array<{
        task_id: string;
        title: string;
        owner_role: string;
        parent_task_id?: string;
        dependencies?: string[];
        write_set?: string[];
        acceptance?: string[];
        artifacts?: string[];
      }>;
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
    ),

  listRuns: () =>
    fetchJSON<{ items: WorkflowRunRecord[]; total: number }>(`${API_BASE}/workflow-runs`).then((payload) => ({
      ...payload,
      items: (payload.items ?? []).map(normalizeWorkflowRunRecord)
    })),

  getRun: (runId: string) =>
    fetchJSON<WorkflowRunRecord>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}`).then(
      normalizeWorkflowRunRecord
    ),

  createRun: (data: {
    template_id: string;
    run_id?: string;
    name?: string;
    description?: string;
    workspace_path: string;
    variables?: Record<string, string>;
    task_overrides?: Record<string, string>;
    auto_start?: boolean;
    mode?: WorkflowRunMode;
    loop_enabled?: boolean;
    schedule_enabled?: boolean;
    schedule_expression?: string;
    is_schedule_seed?: boolean;
    auto_dispatch_enabled?: boolean;
    auto_dispatch_remaining?: number;
  }) =>
    fetchJSON<WorkflowRunRecord>(`${API_BASE}/workflow-runs`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  startRun: (runId: string) =>
    fetchJSON<{ runtime: WorkflowRunRuntimeStatus; run: WorkflowRunRecord | null }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/start`,
      { method: "POST" }
    ).then((payload) => ({
      ...payload,
      run: payload.run ? normalizeWorkflowRunRecord(payload.run) : payload.run
    })),

  stopRun: (runId: string) =>
    fetchJSON<{ runtime: WorkflowRunRuntimeStatus; run: WorkflowRunRecord | null }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/stop`,
      { method: "POST" }
    ).then((payload) => ({
      ...payload,
      run: payload.run ? normalizeWorkflowRunRecord(payload.run) : payload.run
    })),

  getRunStatus: (runId: string) =>
    fetchJSON<WorkflowRunRuntimeStatus>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/status`),

  getTaskRuntime: (runId: string) =>
    fetchJSON<WorkflowRunRuntimeSnapshot>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-runtime`).then(
      normalizeWorkflowRunRuntimeSnapshot
    ),

  getTaskTreeRuntime: (runId: string) =>
    fetchJSON<WorkflowTaskTreeRuntimeResponse>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-tree-runtime`
    ).then(normalizeWorkflowTaskTreeRuntimeResponse),

  getTaskTree: (
    runId: string,
    query?: {
      focus_task_id?: string;
      max_descendant_depth?: number;
      include_external_dependencies?: boolean;
    }
  ) => {
    const params = new URLSearchParams();
    if (query?.focus_task_id) params.set("focus_task_id", query.focus_task_id);
    if (typeof query?.max_descendant_depth === "number") {
      params.set("max_descendant_depth", String(query.max_descendant_depth));
    }
    if (typeof query?.include_external_dependencies === "boolean") {
      params.set("include_external_dependencies", query.include_external_dependencies ? "true" : "false");
    }
    const suffix = params.toString();
    return fetchJSON<TaskTreeResponse>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-tree${suffix ? `?${suffix}` : ""}`
    ).then(normalizeTaskTreeResponse);
  },

  getTaskDetail: (runId: string, taskId: string) =>
    fetchJSON<TaskDetail>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/detail`
    ).then(normalizeTaskDetail),

  taskAction: (runId: string, data: WorkflowTaskActionRequest) =>
    fetchJSON<WorkflowTaskActionResult>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-actions`, {
      method: "POST",
      body: JSON.stringify(data)
    }).then((payload) => ({
      ...payload,
      snapshot: normalizeWorkflowRunRuntimeSnapshot(payload.snapshot)
    })),

  getSessions: (runId: string) =>
    fetchJSON<{ run_id: string; items: Record<string, unknown>[] }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions`
    ).then((payload) => ({
      run_id: payload.run_id,
      items: (payload.items ?? []).map(mapWorkflowSessionFields)
    })),

  getRuntimeRecovery: async (runId: string): Promise<RuntimeRecoveryResponse> =>
    mapRuntimeRecoveryResponse(
      await fetchJSON<Record<string, unknown>>(
        `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/runtime-recovery?attempt_limit=${RECOVERY_CENTER_ATTEMPT_LIMIT}`
      )
    ),

  getSessionRecoveryAttempts: async (
    runId: string,
    sessionId: string,
    attemptLimit: number | "all" = "all"
  ): Promise<RuntimeRecoveryAttemptsResponse> =>
    mapRuntimeRecoveryAttemptsResponse(
      await fetchJSON<Record<string, unknown>>(
        `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(sessionId)}/recovery-attempts?attempt_limit=${encodeURIComponent(String(attemptLimit))}`
      )
    ),

  registerSession: (
    runId: string,
    data: {
      role: string;
      session_id?: string;
      status?: "running" | "idle" | "blocked" | "dismissed";
      provider_id?: "codex" | "minimax";
      provider?: "codex" | "minimax";
      provider_session_id?: string;
    }
  ) =>
    fetchJSON<{ session: Record<string, unknown>; created: boolean }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    ).then((payload) => ({
      session: mapWorkflowSessionFields(payload.session),
      created: payload.created
    })),

  dismissSession: (runId: string, sessionId: string, reason?: string, confirm?: boolean) =>
    fetchJSON<{
      action: "dismiss";
      session: Record<string, unknown>;
      previous_status: string;
      next_status: string;
      provider_cancel: Record<string, unknown>;
      process_termination: Record<string, unknown> | null;
      mapping_cleared: boolean;
      warnings: string[];
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(sessionId)}/dismiss`, {
      method: "POST",
      body: JSON.stringify({
        reason: reason ?? "dashboard_manual_dismiss",
        actor: "dashboard",
        ...(confirm ? { confirm: true } : {})
      })
    }).then((payload) => ({
      ...payload,
      session: mapWorkflowSessionFields(payload.session)
    })),

  repairSession: (runId: string, sessionId: string, targetStatus: "idle" | "blocked", confirm?: boolean) =>
    fetchJSON<{
      action: "repair";
      session: Record<string, unknown>;
      previous_status: string;
      next_status: string;
      warnings: string[];
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(sessionId)}/repair`, {
      method: "POST",
      body: JSON.stringify({
        target_status: targetStatus,
        reason: "dashboard_manual_repair",
        actor: "dashboard",
        ...(confirm ? { confirm: true } : {})
      })
    }).then((payload) => ({
      ...payload,
      session: mapWorkflowSessionFields(payload.session)
    })),

  retryDispatchSession: (runId: string, item: RuntimeRecoveryItem, confirm?: boolean) =>
    fetchJSON<Record<string, unknown>>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(item.session_id)}/retry-dispatch`,
      {
        method: "POST",
        body: JSON.stringify(buildRetryDispatchGuardBody(item, "dashboard_manual_retry_dispatch", confirm))
      }
    ),

  sendMessage: (
    runId: string,
    data: {
      from_agent?: string;
      from_session_id?: string;
      to?: { agent?: string; role?: string; session_id?: string };
      to_role?: string;
      to_session_id?: string;
      message_type?: "MANAGER_MESSAGE" | "TASK_DISCUSS_REQUEST" | "TASK_DISCUSS_REPLY" | "TASK_DISCUSS_CLOSED";
      task_id?: string;
      content: string;
      request_id?: string;
      parent_request_id?: string;
      discuss?: { thread_id?: string; request_id?: string };
    }
  ) =>
    fetchJSON<{
      requestId: string;
      messageId: string;
      messageType: string;
      taskId: string | null;
      toRole: string | null;
      resolvedSessionId: string;
      createdAt: string;
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/messages/send`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  getTimeline: async (runId: string, limit = 300): Promise<{ items: AgentIOTimelineItem[]; total: number }> => {
    const data = await fetchJSON<{ items: Record<string, unknown>[]; total: number }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/agent-io/timeline?limit=${encodeURIComponent(String(limit))}`
    );
    return {
      total: data.total ?? 0,
      items: (data.items ?? []).map((raw) => ({
        id: (raw.itemId ?? raw.id) as string,
        projectId: (raw.projectId ?? raw.project_id ?? "") as string,
        sessionId: (raw.sessionId ?? raw.session_id ?? raw.toSessionId ?? "") as string,
        role: (raw.role ?? raw.from ?? raw.originAgent ?? "") as string,
        taskId: (raw.taskId ?? raw.task_id) as string | undefined,
        direction: (raw.direction ?? "inbound") as "inbound" | "outbound",
        messageType: (raw.messageType ?? raw.message_type ?? raw.kind ?? "") as string,
        summary: (raw.content ?? raw.summary) as string | undefined,
        createdAt: (raw.createdAt ?? raw.created_at) as string,
        from: raw.from as string | undefined,
        toRole: (raw.toRole ?? raw.to_role) as string | undefined,
        sourceType: raw.sourceType as "user" | "agent" | "manager" | "system" | undefined,
        originAgent: raw.originAgent as string | undefined,
        kind: raw.kind as string | undefined,
        status: raw.status as string | undefined,
        runId: (raw.runId ?? runId) as string | undefined
      }))
    };
  },

  getOrchestratorSettings: (runId: string) =>
    fetchJSON<WorkflowRunOrchestratorSettings>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/orchestrator/settings`
    ),

  patchOrchestratorSettings: (
    runId: string,
    data: {
      auto_dispatch_enabled?: boolean;
      auto_dispatch_remaining?: number;
      hold_enabled?: boolean;
      reminder_mode?: "backoff" | "fixed_interval";
      mode?: WorkflowRunMode;
      loop_enabled?: boolean;
      schedule_enabled?: boolean;
      schedule_expression?: string | null;
      is_schedule_seed?: boolean;
    }
  ) =>
    fetchJSON<WorkflowRunOrchestratorSettings>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/orchestrator/settings`,
      {
        method: "PATCH",
        body: JSON.stringify(data)
      }
    ),

  dispatch: (runId: string, data: { role?: string; task_id?: string; force?: boolean; only_idle?: boolean } = {}) =>
    fetchJSON<{
      runId: string;
      dispatchedCount: number;
      remainingBudget: number;
      results: Array<{
        role: string;
        sessionId: string | null;
        taskId: string | null;
        dispatchKind?: "task" | "message" | null;
        messageId?: string;
        requestId?: string;
        outcome: "dispatched" | "no_task" | "session_busy" | "run_not_running" | "invalid_target";
        reason?: string;
      }>;
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/orchestrator/dispatch`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  interruptAgentChat: (runId: string, sessionId: string) =>
    fetchJSON<{ success: boolean; cancelled: boolean }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/agent-chat/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST" }
    ),

  getOrchestratorStatus: () => fetchJSON<WorkflowOrchestratorStatus>(`${API_BASE}/workflow-orchestrator/status`)
};
