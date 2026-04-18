import type { TaskState } from "../../../domain/models.js";

const ORCHESTRATOR_REPORTABLE_TASK_STATES = new Set<TaskState>([
  "PLANNED",
  "READY",
  "DISPATCHED",
  "IN_PROGRESS",
  "BLOCKED_DEP"
]);

const ORCHESTRATOR_RETIRED_TASK_REPORT_OUTCOMES = new Set(["PARTIAL", "BLOCKED", "FAILED"]);

const ORCHESTRATOR_STABLE_TASK_REPORT_OUTCOMES = ["IN_PROGRESS", "BLOCKED_DEP", "DONE", "CANCELED"] as const;

export function normalizeOrchestratorTaskReportOutcomeToken(outcome: string): string {
  return outcome.trim().toUpperCase();
}

export function isOrchestratorRetiredTaskReportOutcome(outcome: string): boolean {
  return ORCHESTRATOR_RETIRED_TASK_REPORT_OUTCOMES.has(normalizeOrchestratorTaskReportOutcomeToken(outcome));
}

export function getOrchestratorTaskReportOutcomeLabel(): string {
  return ORCHESTRATOR_STABLE_TASK_REPORT_OUTCOMES.join("|");
}

export function parseOrchestratorTaskReportOutcome(outcome: string): TaskState | null {
  const normalized = normalizeOrchestratorTaskReportOutcomeToken(outcome);
  if (normalized === "IN_PROGRESS") {
    return "IN_PROGRESS";
  }
  if (normalized === "BLOCKED_DEP") {
    return "BLOCKED_DEP";
  }
  if (normalized === "DONE") {
    return "DONE";
  }
  if (normalized === "CANCELED") {
    return "CANCELED";
  }
  return null;
}

export function isOrchestratorTaskReportableState(state: TaskState): boolean {
  return ORCHESTRATOR_REPORTABLE_TASK_STATES.has(state);
}

export function buildOrchestratorDependencyNotReadyNextAction(taskId: string, dependencyTaskIds: string[]): string {
  const deps = dependencyTaskIds.join(", ");
  return (
    `Task '${taskId}' is blocked by dependencies [${deps}]. ` +
    "Wait for dependencies to resolve first. " +
    "Wait until they are DONE/CANCELED before reporting IN_PROGRESS/DONE. " +
    "If you already wrote conflicting completion claims, retract or downgrade them to draft until dependencies are ready."
  );
}
