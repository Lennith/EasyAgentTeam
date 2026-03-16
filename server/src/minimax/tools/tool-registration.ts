import type { Tool } from "./Tool.js";
import type { ToolRegistry } from "./ToolRegistry.js";

export type ToolSource = "team" | "core" | "other";

interface CapabilityRegistration {
  toolName: string;
  source: ToolSource;
  priority: number;
}

export interface ToolRegistrationState {
  byCapability: Map<string, CapabilityRegistration>;
  byName: Set<string>;
}

export interface ToolRegistrationSkip {
  skipped: true;
  reason: "duplicate_name" | "capability_conflict";
  toolName: string;
  capability: string;
  keptToolName?: string;
  keptSource?: ToolSource;
}

export interface ToolRegistrationApplied {
  skipped: false;
  replaced?: {
    toolName: string;
    source: ToolSource;
  };
}

export type ToolRegistrationResult = ToolRegistrationSkip | ToolRegistrationApplied;

export function createToolRegistrationState(): ToolRegistrationState {
  return {
    byCapability: new Map<string, CapabilityRegistration>(),
    byName: new Set<string>()
  };
}

function sourcePriority(source: ToolSource): number {
  if (source === "team") {
    return 3;
  }
  if (source === "core") {
    return 2;
  }
  return 1;
}

export function resolveToolCapabilityFamily(name: string): string {
  const normalized = name.trim().toLowerCase();
  switch (normalized) {
    case "task_create_assign":
    case "task_create":
    case "task_assign":
      return "task_manage";
    case "task_report_in_progress":
    case "report_in_progress":
      return "task_report_in_progress";
    case "task_report_done":
    case "report_task_done":
      return "task_report_done";
    case "task_report_block":
    case "report_task_block":
      return "task_report_block";
    case "discuss_request":
    case "task_discuss_request":
      return "discuss_request";
    case "discuss_reply":
    case "task_discuss_reply":
      return "discuss_reply";
    case "discuss_close":
    case "task_discuss_close":
      return "discuss_close";
    case "route_targets_get":
      return "route";
    case "lock_manage":
      return "lock";
    case "read_file":
      return "file_read";
    case "write_file":
      return "file_write";
    case "edit_file":
      return "file_edit";
    case "glob":
      return "file_glob";
    case "grep":
      return "file_grep";
    case "web_fetch":
      return "web_fetch";
    case "web_search":
      return "web_search";
    case "shell_execute":
      return "shell_exec";
    case "note":
    case "session_note":
      return "note";
    case "summary_messages":
      return "summary_messages";
    default:
      return `tool:${normalized}`;
  }
}

export function registerToolWithDedupe(
  registry: ToolRegistry,
  state: ToolRegistrationState,
  tool: Tool,
  source: ToolSource
): ToolRegistrationResult {
  const toolName = tool.name;
  if (state.byName.has(toolName)) {
    return {
      skipped: true,
      reason: "duplicate_name",
      toolName,
      capability: resolveToolCapabilityFamily(toolName),
      keptToolName: toolName,
      keptSource: state.byCapability.get(resolveToolCapabilityFamily(toolName))?.source
    };
  }

  const capability = resolveToolCapabilityFamily(toolName);
  const existing = state.byCapability.get(capability);
  const currentPriority = sourcePriority(source);
  if (existing && existing.priority >= currentPriority) {
    return {
      skipped: true,
      reason: "capability_conflict",
      toolName,
      capability,
      keptToolName: existing.toolName,
      keptSource: existing.source
    };
  }

  let replaced: ToolRegistrationApplied["replaced"];
  if (existing && existing.priority < currentPriority) {
    registry.unregister(existing.toolName);
    state.byName.delete(existing.toolName);
    replaced = { toolName: existing.toolName, source: existing.source };
  }

  registry.register(tool);
  state.byName.add(toolName);
  state.byCapability.set(capability, {
    toolName,
    source,
    priority: currentPriority
  });
  return {
    skipped: false,
    replaced
  };
}
