import type {
  ProjectSummary,
  ProjectDetail,
  SessionRecord,
  TaskTreeResponse,
  TaskTreeNode,
  TaskDetail,
  LockRecord,
  EventRecord,
  AgentDefinition,
  AgentTemplateDefinition,
  TemplateDefinition,
  AgentIOTimelineItem,
  OrchestratorStatus,
  OrchestratorSettings,
  RuntimeSettings,
  ModelInfo,
  SendMessageRequest,
  CreateProjectRequest,
  RoutingConfigRequest,
  DispatchResult,
  TaskActionRequest,
  TaskPatchRequest,
  TeamRecord,
  TeamSummary,
  CreateTeamRequest,
  UpdateTeamRequest,
  WorkflowTemplateRecord,
  WorkflowRunRecord,
  WorkflowRunRuntimeStatus,
  WorkflowRunRuntimeSnapshot,
  WorkflowTaskTreeRuntimeResponse,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult,
  WorkflowOrchestratorStatus,
  WorkflowSessionRecord
} from "@/types";

const API_BASE = "/api";

function formatError(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(error);
    } catch {
      return "[object Object]";
    }
  }
  return String(error);
}

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options
  });
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) {
    throw new Error(formatError((data as { error?: unknown }).error) ?? `HTTP ${response.status}`);
  }
  return data as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    let data: unknown = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    throw new Error(formatError((data as { error?: unknown }).error) ?? `HTTP ${response.status}`);
  }
  return response.text();
}

function mapSessionFields(raw: Record<string, unknown>): SessionRecord {
  return {
    sessionId: (raw.sessionId ?? raw.session_id ?? raw.sessionKey) as string,
    projectId: (raw.projectId ?? raw.project_id) as string,
    role: raw.role as string,
    status: raw.status as SessionRecord["status"],
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    updatedAt: (raw.updatedAt ?? raw.updated_at) as string,
    currentTaskId: (raw.currentTaskId ?? raw.current_task_id) as string | undefined,
    lastHeartbeat: (raw.lastActiveAt ?? raw.last_heartbeat ?? raw.lastHeartbeat) as string | undefined,
    lastActiveAt: (raw.lastActiveAt ?? raw.last_active_at) as string | undefined,
    lastDispatchedAt: (raw.lastDispatchedAt ?? raw.last_dispatched_at) as string | undefined,
    agentTool: raw.agentTool as string | undefined,
    sessionKey: raw.sessionKey as string | undefined,
    providerSessionId: raw.providerSessionId as string | null | undefined,
    provider: raw.provider as string | undefined,
    locksHeldCount: raw.locksHeldCount as number | undefined
  };
}

function mapEventFields(raw: Record<string, unknown>): EventRecord {
  return {
    eventId: (raw.eventId ?? raw.event_id) as string,
    eventType: (raw.eventType ?? raw.event_type) as string,
    source: raw.source as string,
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    sessionId: (raw.sessionId ?? raw.session_id) as string | undefined,
    payload: (raw.payload ?? {}) as Record<string, unknown>
  };
}

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
    if (options?.include_external_dependencies !== undefined)
      params.set("include_external_dependencies", String(options.include_external_dependencies));
    const query = params.toString();
    const url = `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-tree${query ? `?${query}` : ""}`;
    return fetchJSON<TaskTreeResponse>(url);
  },

  getTaskDetail: (projectId: string, taskId: string) =>
    fetchJSON<TaskDetail>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/detail`
    ),

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
    ),

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

  dismissSession: (projectId: string, sessionId: string, reason?: string) =>
    fetchJSON<{ success: boolean }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/dismiss`,
      {
        method: "POST",
        body: JSON.stringify({ reason: reason ?? "dashboard_manual_dismiss" })
      }
    ),

  repairSession: (projectId: string, sessionId: string, targetStatus: "idle" | "blocked") =>
    fetchJSON<{ success: boolean }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/repair`,
      {
        method: "POST",
        body: JSON.stringify({ target_status: targetStatus })
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
          updatedAt: (raw.updatedAt ?? raw.updated_at) as string,
          defaultCliTool: raw.defaultCliTool as "codex" | "trae" | "minimax" | undefined,
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
          updatedAt: (raw.updatedAt ?? raw.updated_at ?? new Date().toISOString()) as string,
          defaultCliTool: raw.defaultCliTool as "codex" | "trae" | "minimax" | undefined,
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
          updatedAt: (raw.updatedAt ?? raw.updated_at ?? new Date().toISOString()) as string,
          defaultCliTool: raw.defaultCliTool as "codex" | "trae" | "minimax" | undefined,
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
    default_cli_tool?: "codex" | "trae" | "minimax";
  }) =>
    fetchJSON<{ agentId: string }>(`${API_BASE}/agents`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  update: (
    agentId: string,
    data: { display_name?: string; prompt?: string; default_cli_tool?: "codex" | "trae" | "minimax" }
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

export const projectTemplateApi = {
  list: () => fetchJSON<{ items: TemplateDefinition[] }>(`${API_BASE}/project-templates`)
};

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

  listRuns: () => fetchJSON<{ items: WorkflowRunRecord[]; total: number }>(`${API_BASE}/workflow-runs`),

  getRun: (runId: string) => fetchJSON<WorkflowRunRecord>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}`),

  createRun: (data: {
    template_id: string;
    run_id?: string;
    name?: string;
    description?: string;
    workspace_path: string;
    variables?: Record<string, string>;
    task_overrides?: Record<string, string>;
    auto_start?: boolean;
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
      {
        method: "POST"
      }
    ),

  stopRun: (runId: string) =>
    fetchJSON<{ runtime: WorkflowRunRuntimeStatus; run: WorkflowRunRecord | null }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/stop`,
      {
        method: "POST"
      }
    ),

  getRunStatus: (runId: string) =>
    fetchJSON<WorkflowRunRuntimeStatus>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/status`),

  getTaskRuntime: (runId: string) =>
    fetchJSON<WorkflowRunRuntimeSnapshot>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-runtime`),

  getTaskTreeRuntime: (runId: string) =>
    fetchJSON<WorkflowTaskTreeRuntimeResponse>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-tree-runtime`
    ),

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
    );
  },

  getTaskDetail: (runId: string, taskId: string) =>
    fetchJSON<TaskDetail>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/detail`
    ),

  taskAction: (runId: string, data: WorkflowTaskActionRequest) =>
    fetchJSON<WorkflowTaskActionResult>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-actions`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  getSessions: (runId: string) =>
    fetchJSON<{ run_id: string; items: WorkflowSessionRecord[] }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions`
    ),

  registerSession: (
    runId: string,
    data: {
      role: string;
      session_id?: string;
      status?: "running" | "idle" | "blocked" | "dismissed";
      provider?: "codex" | "trae" | "minimax";
      provider_session_id?: string;
    }
  ) =>
    fetchJSON<{ session: WorkflowSessionRecord; created: boolean }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions`,
      {
        method: "POST",
        body: JSON.stringify(data)
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
    fetchJSON<{
      run_id: string;
      auto_dispatch_enabled: boolean;
      auto_dispatch_remaining: number;
      hold_enabled: boolean;
      reminder_mode: "backoff" | "fixed_interval";
      updated_at: string;
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/orchestrator/settings`),

  patchOrchestratorSettings: (
    runId: string,
    data: {
      auto_dispatch_enabled?: boolean;
      auto_dispatch_remaining?: number;
      hold_enabled?: boolean;
      reminder_mode?: "backoff" | "fixed_interval";
    }
  ) =>
    fetchJSON<{
      run_id: string;
      auto_dispatch_enabled: boolean;
      auto_dispatch_remaining: number;
      hold_enabled: boolean;
      reminder_mode: "backoff" | "fixed_interval";
      updated_at: string;
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/orchestrator/settings`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

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

export const orchestratorApi = {
  getStatus: () => fetchJSON<OrchestratorStatus>(`${API_BASE}/orchestrator/status`)
};

export const settingsApi = {
  get: () => fetchJSON<RuntimeSettings>(`${API_BASE}/settings`),

  update: (data: Partial<RuntimeSettings>) =>
    fetchJSON<{ success: boolean }>(`${API_BASE}/settings`, {
      method: "PATCH",
      body: JSON.stringify(data)
    })
};

export const modelsApi = {
  list: (projectId?: string, refresh?: boolean) => {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);
    if (refresh) params.set("refresh", "true");
    return fetchJSON<{ models: ModelInfo[]; warnings?: string[]; source?: "cache" | "refresh" | "fallback-mixed" }>(
      `${API_BASE}/models?${params.toString()}`
    );
  }
};

export const teamApi = {
  list: () => fetchJSON<{ items: TeamSummary[] }>(`${API_BASE}/teams`),

  get: (teamId: string) => fetchJSON<TeamRecord>(`${API_BASE}/teams/${encodeURIComponent(teamId)}`),

  create: (data: CreateTeamRequest) =>
    fetchJSON<TeamRecord>(`${API_BASE}/teams`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  update: (teamId: string, data: UpdateTeamRequest) =>
    fetchJSON<TeamRecord>(`${API_BASE}/teams/${encodeURIComponent(teamId)}`, {
      method: "PUT",
      body: JSON.stringify(data)
    }),

  delete: (teamId: string) =>
    fetchJSON<{ removed: boolean }>(`${API_BASE}/teams/${encodeURIComponent(teamId)}`, {
      method: "DELETE"
    })
};
