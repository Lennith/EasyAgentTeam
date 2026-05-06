export interface TriggerPluginRecord {
  pluginId: string;
  name: string;
  description?: string;
  entry: string;
  sourcePath: string;
  packagePath: string;
  hasCompletionHook: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerConfigRecord {
  triggerId: string;
  pluginId: string;
  enabled: boolean;
  intervalSeconds: number;
  workflowTemplateId: string;
  workspacePath: string;
  defaultVariables?: Record<string, string>;
  hookTimeoutMs: number;
  sessionMode: "fresh" | "reuse_provider_session";
  lastCheckedAt?: string;
  nextCheckAt?: string;
  lastFireId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerSessionBindingRecord {
  bindingId: string;
  triggerId: string;
  workflowTemplateId: string;
  role: string;
  provider: "codex" | "minimax" | "dpagent";
  providerSessionId?: string;
  activeFireId?: string;
  activeWorkflowRunId?: string;
  lastFireId?: string;
  lastWorkflowRunId?: string;
  createdAt: string;
  updatedAt: string;
  lastObservedAt?: string;
}

export type TriggerFireStatus = "skipped" | "fired" | "failed" | "completed";

export interface TriggerRunHistoryItem {
  fireId: string;
  triggerId: string;
  pluginId: string;
  status: TriggerFireStatus;
  workflowRunId?: string;
  reason?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  completionVerdict?: {
    accepted: boolean;
    summary?: string;
    reason?: string;
  };
}

export interface TriggerExecutionResult {
  status: TriggerFireStatus;
  fireId: string;
  triggerId: string;
  pluginId: string;
  workflowRunId?: string;
  reason?: string;
  error?: string;
}
