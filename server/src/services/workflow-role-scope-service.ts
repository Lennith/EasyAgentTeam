import type { WorkflowRunRecord, WorkflowSessionRecord } from "../domain/models.js";

export interface WorkflowRunRoleScope {
  enabledAgents: string[];
  enabledAgentSet: Set<string>;
  hasExplicitRouting: boolean;
}

function normalizeRole(role: string | undefined): string {
  return (role ?? "").trim();
}

function uniq(items: string[]): string[] {
  return Array.from(new Set(items));
}

function collectRouteRoles(routeTable?: Record<string, string[]>): string[] {
  if (!routeTable || Object.keys(routeTable).length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const [fromRaw, targetsRaw] of Object.entries(routeTable)) {
    const from = normalizeRole(fromRaw);
    if (from) {
      out.push(from);
    }
    for (const toRaw of targetsRaw ?? []) {
      const to = normalizeRole(toRaw);
      if (to) {
        out.push(to);
      }
    }
  }
  return out;
}

export function resolveWorkflowRunRoleScope(
  run: WorkflowRunRecord,
  sessions: WorkflowSessionRecord[] = []
): WorkflowRunRoleScope {
  const sessionRoles = sessions.map((item) => normalizeRole(item.role)).filter((item) => item.length > 0);
  const mappedRoles = Object.keys(run.roleSessionMap ?? {})
    .map((item) => normalizeRole(item))
    .filter((item) => item.length > 0);
  const routeRoles = [...collectRouteRoles(run.routeTable), ...collectRouteRoles(run.taskAssignRouteTable)].filter(
    (item) => item.length > 0
  );
  const taskRoles = (run.tasks ?? []).map((task) => normalizeRole(task.ownerRole)).filter((item) => item.length > 0);
  const hasExplicitRouting = routeRoles.length > 0;

  const enabledAgents = hasExplicitRouting
    ? uniq([...routeRoles, ...sessionRoles, ...mappedRoles])
    : uniq([...taskRoles, ...sessionRoles, ...mappedRoles]);
  return {
    enabledAgents,
    enabledAgentSet: new Set(enabledAgents),
    hasExplicitRouting
  };
}
