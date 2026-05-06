import type {
  ProviderId,
  TriggerAction,
  TriggerCheckResult,
  TriggerCompletionVerdict,
  TriggerSessionMode
} from "@autodev/agent-library";

export type TriggerFireStatus = "skipped" | "fired" | "failed" | "completed";

export interface TriggerPluginRecord {
  schemaVersion: "1.0";
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
  schemaVersion: "1.0";
  triggerId: string;
  pluginId: string;
  enabled: boolean;
  intervalSeconds: number;
  workflowTemplateId: string;
  workspacePath: string;
  defaultVariables?: Record<string, string>;
  hookTimeoutMs: number;
  sessionMode: TriggerSessionMode;
  lastCheckedAt?: string;
  nextCheckAt?: string;
  lastFireId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerRegistryState {
  schemaVersion: "1.0";
  updatedAt: string;
  plugins: TriggerPluginRecord[];
  triggers: TriggerConfigRecord[];
  sessionBindings: TriggerSessionBindingRecord[];
}

export interface TriggerSessionBindingRecord {
  schemaVersion: "1.0";
  bindingId: string;
  triggerId: string;
  workflowTemplateId: string;
  role: string;
  provider: ProviderId;
  providerSessionId?: string;
  activeFireId?: string;
  activeWorkflowRunId?: string;
  lastFireId?: string;
  lastWorkflowRunId?: string;
  createdAt: string;
  updatedAt: string;
  lastObservedAt?: string;
}

export type TriggerAuditEventType =
  | "TRIGGER_PLUGIN_IMPORTED"
  | "TRIGGER_CHECK_STARTED"
  | "TRIGGER_CHECK_SKIPPED"
  | "TRIGGER_HOOK_FAILED"
  | "TRIGGER_WORKFLOW_RUN_CREATED"
  | "TRIGGER_WORKFLOW_RUN_START_FAILED"
  | "TRIGGER_SESSION_BINDING_UPDATED"
  | "TRIGGER_SESSION_BINDING_RESET"
  | "TRIGGER_WORKFLOW_COMPLETED"
  | "TRIGGER_WORKFLOW_COMPLETION_FAILED"
  | "TRIGGER_COMPLETION_HOOK_FAILED";

export interface TriggerAuditEvent {
  schemaVersion: "1.0";
  eventId: string;
  triggerId?: string;
  pluginId?: string;
  fireId?: string;
  eventType: TriggerAuditEventType;
  createdAt: string;
  payload: Record<string, unknown>;
}

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
  completionVerdict?: TriggerCompletionVerdict;
}

export interface TriggerExecutionContext {
  trigger: TriggerConfigRecord & {
    trigger_id: string;
    plugin_id: string;
    workflow_template_id: string;
    workspace_path: string;
    session_mode: TriggerSessionMode;
  };
  plugin: TriggerPluginRecord;
  dataDir: string;
  workspacePath: string;
  defaultVariables: Record<string, string>;
  now: string;
  manual: boolean;
}

export interface TriggerExecutionResult {
  status: TriggerFireStatus;
  fireId: string;
  triggerId: string;
  pluginId: string;
  checkResult?: TriggerCheckResult;
  action?: TriggerAction;
  workflowRunId?: string;
  reason?: string;
  error?: string;
}
