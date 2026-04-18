import type { TaskState, TaskSubtreePayload, TaskSubtreeTerminalReport } from "../../../domain/models.js";

export interface OrchestratorTaskSubtreeNode {
  taskId: string;
  parentTaskId?: string | null;
  state: string;
  ownerRole: string;
  ownerSession?: string | null;
  closeReportId?: string | null;
  lastSummary?: string | null;
}

function isResolvedDescendantState(state: string): boolean {
  return state === "DONE" || state === "CANCELED";
}

function isTerminalDescendantReportState(state: string): state is TaskState {
  return state === "DONE" || state === "CANCELED";
}

function buildChildrenMap(tasks: OrchestratorTaskSubtreeNode[]): Map<string, OrchestratorTaskSubtreeNode[]> {
  const childrenByParent = new Map<string, OrchestratorTaskSubtreeNode[]>();
  for (const task of tasks) {
    const parentTaskId = task.parentTaskId?.trim();
    if (!parentTaskId || parentTaskId === task.taskId) {
      continue;
    }
    const existing = childrenByParent.get(parentTaskId) ?? [];
    existing.push(task);
    childrenByParent.set(parentTaskId, existing);
  }
  return childrenByParent;
}

function collectDescendants(
  focusTaskId: string,
  childrenByParent: Map<string, OrchestratorTaskSubtreeNode[]>
): OrchestratorTaskSubtreeNode[] {
  const descendants: OrchestratorTaskSubtreeNode[] = [];
  const queue = [...(childrenByParent.get(focusTaskId) ?? [])];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.taskId)) {
      continue;
    }
    visited.add(current.taskId);
    descendants.push(current);
    queue.push(...(childrenByParent.get(current.taskId) ?? []));
  }

  return descendants;
}

export function buildOrchestratorTaskSubtreePayload(
  focusTaskId: string,
  tasks: OrchestratorTaskSubtreeNode[]
): TaskSubtreePayload {
  const descendants = collectDescendants(focusTaskId, buildChildrenMap(tasks));
  const unresolvedDescendantIds = descendants
    .filter((task) => !isResolvedDescendantState(task.state))
    .map((task) => task.taskId);
  const terminalDescendantReports: TaskSubtreeTerminalReport[] = descendants
    .filter((task) => isTerminalDescendantReportState(task.state))
    .map((task) => ({
      task_id: task.taskId,
      state: task.state as TaskState,
      owner_role: task.ownerRole,
      owner_session: task.ownerSession ?? null,
      close_report_id: task.closeReportId ?? null,
      last_summary: task.lastSummary?.trim() || null
    }));

  return {
    focus_task_id: focusTaskId,
    descendant_ids: descendants.map((task) => task.taskId),
    descendant_counts: {
      total: descendants.length,
      unresolved: unresolvedDescendantIds.length,
      done: descendants.filter((task) => task.state === "DONE").length,
      blocked: descendants.filter((task) => task.state === "BLOCKED_DEP").length,
      canceled: descendants.filter((task) => task.state === "CANCELED").length
    },
    unresolved_descendant_ids: unresolvedDescendantIds,
    terminal_descendant_reports: terminalDescendantReports
  };
}

export function hasOrchestratorUnresolvedDescendants(
  focusTaskId: string,
  tasks: OrchestratorTaskSubtreeNode[]
): boolean {
  return buildOrchestratorTaskSubtreePayload(focusTaskId, tasks).unresolved_descendant_ids.length > 0;
}

export function buildOrchestratorTaskSubtreeSummary(
  taskSubtree: TaskSubtreePayload,
  fallbackSummary?: string | null
): string {
  if (taskSubtree.descendant_counts.total === 0) {
    return fallbackSummary?.trim() ?? "";
  }

  const counts = taskSubtree.descendant_counts;
  return (
    `task_subtree: total=${counts.total}, unresolved=${counts.unresolved}, ` +
    `done=${counts.done}, blocked=${counts.blocked}, canceled=${counts.canceled}. ` +
    "Use task_subtree to decide whether to continue, wait for descendants, or report parent progress."
  );
}

export function buildOrchestratorTaskRedispatchSummary(
  taskState: string,
  taskSubtree: TaskSubtreePayload,
  fallbackSummary?: string | null
): string {
  return buildOrchestratorTaskSubtreeSummary(taskSubtree, fallbackSummary);
}
