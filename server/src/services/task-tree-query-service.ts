import type { TaskRecord, TaskTreeEdge, TaskTreeNode, TaskTreeResponse } from "../domain/models.js";

interface BuildTaskTreeInput {
  projectId: string;
  tasks: TaskRecord[];
  focusTaskId?: string;
  maxDescendantDepth?: number;
  includeExternalDependencies?: boolean;
}

function toNode(task: TaskRecord): TaskTreeNode {
  return {
    task_id: task.taskId,
    task_detail_id: task.taskId,
    task_kind: task.taskKind,
    parent_task_id: task.parentTaskId,
    root_task_id: task.rootTaskId,
    title: task.title,
    state: task.state,
    creator_role: task.creatorRole ?? null,
    creator_session_id: task.creatorSessionId ?? null,
    owner_role: task.ownerRole,
    owner_session: task.ownerSession ?? null,
    priority: task.priority ?? 0,
    dependencies: [...task.dependencies],
    write_set: [...task.writeSet],
    acceptance: [...task.acceptance],
    artifacts: [...task.artifacts],
    alert: task.alert ?? null,
    granted_at: task.grantedAt ?? null,
    closed_at: task.closedAt ?? null,
    close_report_id: task.closeReportId ?? null,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    last_summary: task.lastSummary ?? null
  };
}

function buildChildrenMap(tasks: TaskRecord[]): Map<string, TaskRecord[]> {
  const map = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    if (!map.has(task.parentTaskId)) {
      map.set(task.parentTaskId, []);
    }
    map.get(task.parentTaskId)!.push(task);
  }
  return map;
}

function collectAncestors(taskId: string, byId: Map<string, TaskRecord>): string[] {
  const ancestors: string[] = [];
  let cursor = byId.get(taskId);
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.taskId)) {
    visited.add(cursor.taskId);
    if (cursor.parentTaskId === cursor.taskId) {
      break;
    }
    const parent = byId.get(cursor.parentTaskId);
    if (!parent) {
      break;
    }
    ancestors.push(parent.taskId);
    cursor = parent;
  }
  return ancestors;
}

function collectDescendants(
  taskId: string,
  childrenByParent: Map<string, TaskRecord[]>,
  maxDepth?: number
): string[] {
  const descendants: string[] = [];
  const queue: Array<{ taskId: string; depth: number }> = [{ taskId, depth: 0 }];
  const visited = new Set<string>([taskId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = (childrenByParent.get(current.taskId) ?? []).filter((child) => child.taskId !== current.taskId);
    for (const child of children) {
      if (visited.has(child.taskId)) {
        continue;
      }
      visited.add(child.taskId);
      descendants.push(child.taskId);
      const nextDepth = current.depth + 1;
      if (maxDepth !== undefined && nextDepth >= maxDepth) {
        continue;
      }
      queue.push({ taskId: child.taskId, depth: nextDepth });
    }
  }
  return descendants;
}

export function buildTaskTreeResponse(input: BuildTaskTreeInput): TaskTreeResponse {
  const includeExternalDependencies = input.includeExternalDependencies ?? true;
  const maxDepth =
    typeof input.maxDescendantDepth === "number" && Number.isFinite(input.maxDescendantDepth) && input.maxDescendantDepth >= 0
      ? Math.floor(input.maxDescendantDepth)
      : undefined;
  const byId = new Map(input.tasks.map((task) => [task.taskId, task]));
  const childrenByParent = buildChildrenMap(input.tasks);

  let selectedTaskIds = new Set(input.tasks.map((task) => task.taskId));
  let ancestorIds: string[] = [];
  let descendantIds: string[] = [];
  if (input.focusTaskId) {
    const focus = byId.get(input.focusTaskId);
    if (!focus) {
      const err = new Error(`task '${input.focusTaskId}' not found`);
      (err as Error & { code?: string }).code = "TASK_NOT_FOUND";
      throw err;
    }
    ancestorIds = collectAncestors(focus.taskId, byId);
    descendantIds = collectDescendants(focus.taskId, childrenByParent, maxDepth);
    selectedTaskIds = new Set([focus.taskId, ...ancestorIds, ...descendantIds]);
  }

  const nodes = input.tasks
    .filter((task) => selectedTaskIds.has(task.taskId))
    .map(toNode)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const nodeSet = new Set(nodes.map((node) => node.task_id));
  const edges: TaskTreeEdge[] = [];
  let externalDependencyEdgeCount = 0;
  for (const node of nodes) {
    if (node.task_id !== node.parent_task_id && nodeSet.has(node.parent_task_id)) {
      edges.push({
        edge_id: `pc:${node.parent_task_id}->${node.task_id}`,
        edge_type: "PARENT_CHILD",
        from_task_id: node.parent_task_id,
        to_task_id: node.task_id,
        external: false
      });
    }
    for (const depId of node.dependencies) {
      const external = !nodeSet.has(depId);
      if (external && !includeExternalDependencies) {
        continue;
      }
      if (external) {
        externalDependencyEdgeCount += 1;
      }
      edges.push({
        edge_id: `dep:${node.task_id}->${depId}`,
        edge_type: "DEPENDS_ON",
        from_task_id: node.task_id,
        to_task_id: depId,
        external
      });
    }
  }

  const roots = nodes
    .filter((node) => node.task_kind === "PROJECT_ROOT" || node.task_kind === "USER_ROOT")
    .map((node) => node.task_id);

  return {
    project_id: input.projectId,
    generated_at: new Date().toISOString(),
    query: {
      focus_task_id: input.focusTaskId ?? null,
      max_descendant_depth: maxDepth ?? null,
      include_external_dependencies: includeExternalDependencies
    },
    roots,
    focus: {
      task_id: input.focusTaskId ?? null,
      ancestor_ids: ancestorIds,
      descendant_ids: descendantIds
    },
    nodes,
    edges,
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      external_dependency_edge_count: externalDependencyEdgeCount
    }
  };
}
