import type { WorkflowRunRecord } from "../../domain/models.js";

export function hasWorkflowRoutePermission(run: WorkflowRunRecord, fromAgent: string, toRole: string): boolean {
  const table = run.routeTable;
  if (!table || Object.keys(table).length === 0) {
    return true;
  }
  return Array.isArray(table[fromAgent]) && table[fromAgent].includes(toRole);
}

export function mergeWorkflowDependencies(parentDependencies: string[], explicitDependencies: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const dep of [...parentDependencies, ...explicitDependencies]) {
    const normalized = dep.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

export function collectWorkflowAncestorTaskIds(
  tasks: WorkflowRunRecord["tasks"],
  taskId: string,
  parentTaskId: string | undefined
): string[] {
  if (!parentTaskId) {
    return [];
  }
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const ancestorTaskIds: string[] = [];
  const visited = new Set<string>([taskId]);
  let currentAncestorId: string | undefined = parentTaskId;
  while (currentAncestorId && !visited.has(currentAncestorId)) {
    ancestorTaskIds.push(currentAncestorId);
    visited.add(currentAncestorId);
    const ancestor = taskById.get(currentAncestorId);
    const nextAncestorId = ancestor?.parentTaskId?.trim();
    if (!ancestor || !nextAncestorId || nextAncestorId === currentAncestorId) {
      break;
    }
    currentAncestorId = nextAncestorId;
  }
  return ancestorTaskIds;
}
