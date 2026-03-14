import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Plus, Save, Trash2 } from "lucide-react";
import { agentApi, teamApi, workflowApi } from "@/services/api";
import type { WorkflowTemplateTaskRecord } from "@/types";

interface WorkflowTemplateEditorViewProps {
  templateId?: string;
}

interface KeyValueRow {
  key: string;
  value: string;
}

interface EditableWorkflowTask extends WorkflowTemplateTaskRecord {
  summary?: string;
  prompt?: string;
}

const ROOT_KEY = "__ROOT__";
const META_PREFIX = "__workflow_meta__:";

function toRows(map?: Record<string, string>): KeyValueRow[] {
  if (!map || Object.keys(map).length === 0) {
    return [{ key: "", value: "" }];
  }
  return Object.entries(map).map(([key, value]) => ({ key, value }));
}

function rowsToMap(rows: KeyValueRow[]): Record<string, string> | undefined {
  const entries = rows
    .map((row) => [row.key.trim(), row.value.trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function splitTextList(input: string): string[] | undefined {
  const values = input
    .split(/\n|,/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return values.length > 0 ? values : undefined;
}

function createTaskId(existing: EditableWorkflowTask[]): string {
  let index = existing.length + 1;
  while (true) {
    const candidate = `task_${index}`;
    if (!existing.some((task) => task.taskId === candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function decodeTaskMeta(task: WorkflowTemplateTaskRecord): EditableWorkflowTask {
  const artifacts = task.artifacts ?? [];
  const metaArtifact = artifacts.find((item) => item.startsWith(META_PREFIX));
  let summary: string | undefined;
  let prompt: string | undefined;
  if (metaArtifact) {
    try {
      const parsed = JSON.parse(metaArtifact.slice(META_PREFIX.length)) as Record<string, unknown>;
      summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
      prompt = typeof parsed.prompt === "string" ? parsed.prompt : undefined;
    } catch {
      // ignore invalid metadata, user can overwrite by saving template
    }
  }
  return {
    ...task,
    artifacts: artifacts.filter((item) => !item.startsWith(META_PREFIX)),
    summary,
    prompt
  };
}

function encodeTaskMeta(task: EditableWorkflowTask): WorkflowTemplateTaskRecord {
  const artifacts = [...(task.artifacts ?? []).filter((item) => !item.startsWith(META_PREFIX))];
  const summary = task.summary?.trim();
  const prompt = task.prompt?.trim();
  if (summary || prompt) {
    artifacts.push(`${META_PREFIX}${JSON.stringify({ summary, prompt })}`);
  }
  return {
    taskId: task.taskId,
    title: task.title,
    ownerRole: task.ownerRole,
    parentTaskId: task.parentTaskId,
    dependencies: task.dependencies,
    writeSet: task.writeSet,
    acceptance: task.acceptance,
    artifacts: artifacts.length > 0 ? artifacts : undefined
  };
}

function validateTemplate(tasks: EditableWorkflowTask[]): string[] {
  const errors: string[] = [];
  const idSet = new Set<string>();

  for (const task of tasks) {
    const taskId = task.taskId.trim();
    if (!taskId) {
      errors.push("Task ID is required.");
      continue;
    }
    if (idSet.has(taskId)) {
      errors.push(`Duplicate task_id detected: ${taskId}`);
    }
    idSet.add(taskId);
    if (!task.title.trim()) {
      errors.push(`Task '${taskId}' requires title.`);
    }
    if (!task.ownerRole.trim()) {
      errors.push(`Task '${taskId}' requires owner_role.`);
    }
  }

  for (const task of tasks) {
    if (task.parentTaskId) {
      if (task.parentTaskId === task.taskId) {
        errors.push(`Task '${task.taskId}' cannot set itself as parent.`);
      }
      if (!idSet.has(task.parentTaskId)) {
        errors.push(`Task '${task.taskId}' points to missing parent '${task.parentTaskId}'.`);
      }
    }
    for (const dep of task.dependencies ?? []) {
      if (dep === task.taskId) {
        errors.push(`Task '${task.taskId}' cannot depend on itself.`);
      }
      if (!idSet.has(dep)) {
        errors.push(`Task '${task.taskId}' points to missing dependency '${dep}'.`);
      }
    }
  }

  const parentMap = Object.fromEntries(tasks.map((task) => [task.taskId, task.parentTaskId]));
  const visited = new Set<string>();
  const stack = new Set<string>();
  const dfsParent = (taskId: string): boolean => {
    if (stack.has(taskId)) {
      return true;
    }
    if (visited.has(taskId)) {
      return false;
    }
    visited.add(taskId);
    stack.add(taskId);
    const parent = parentMap[taskId];
    if (parent && dfsParent(parent)) {
      return true;
    }
    stack.delete(taskId);
    return false;
  };
  for (const task of tasks) {
    if (dfsParent(task.taskId)) {
      errors.push(`Parent cycle detected around '${task.taskId}'.`);
      break;
    }
  }

  return Array.from(new Set(errors));
}

function alignRolesToTeamAgents(currentRoles: string[], teamAgentIds: string[]): Map<string, string> {
  const normalizedTeamAgents = Array.from(
    new Set(teamAgentIds.map((item) => item.trim()).filter((item) => item.length > 0))
  );
  const normalizedRoles = Array.from(
    new Set(currentRoles.map((item) => item.trim()).filter((item) => item.length > 0))
  );
  const mapped = new Map<string, string>();
  if (normalizedTeamAgents.length === 0 || normalizedRoles.length === 0) {
    return mapped;
  }

  const remaining = [...normalizedTeamAgents];
  for (const role of normalizedRoles) {
    const exact = normalizedTeamAgents.find((agentId) => agentId.toLowerCase() === role.toLowerCase());
    if (exact) {
      mapped.set(role, exact);
      const idx = remaining.findIndex((item) => item.toLowerCase() === exact.toLowerCase());
      if (idx >= 0) {
        remaining.splice(idx, 1);
      }
    }
  }

  let roundRobin = 0;
  for (const role of normalizedRoles) {
    if (mapped.has(role)) {
      continue;
    }
    const fallback =
      remaining.length > 0 ? remaining.shift() : normalizedTeamAgents[roundRobin % normalizedTeamAgents.length];
    mapped.set(role, fallback as string);
    roundRobin += 1;
  }

  return mapped;
}

function topologicalSortSibling(
  siblings: EditableWorkflowTask[],
  orderMap: Map<string, number>
): { sorted: EditableWorkflowTask[]; cyclic: boolean } {
  const siblingIds = new Set(siblings.map((task) => task.taskId));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const task of siblings) {
    incoming.set(task.taskId, 0);
    outgoing.set(task.taskId, []);
  }

  for (const task of siblings) {
    for (const dep of task.dependencies ?? []) {
      if (!siblingIds.has(dep)) {
        continue;
      }
      incoming.set(task.taskId, (incoming.get(task.taskId) ?? 0) + 1);
      const out = outgoing.get(dep) ?? [];
      out.push(task.taskId);
      outgoing.set(dep, out);
    }
  }

  const queue = siblings
    .filter((task) => (incoming.get(task.taskId) ?? 0) === 0)
    .sort((a, b) => (orderMap.get(a.taskId) ?? 0) - (orderMap.get(b.taskId) ?? 0))
    .map((task) => task.taskId);

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    result.push(current);
    for (const nextId of outgoing.get(current) ?? []) {
      const value = (incoming.get(nextId) ?? 0) - 1;
      incoming.set(nextId, value);
      if (value === 0) {
        queue.push(nextId);
        queue.sort((a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0));
      }
    }
  }

  if (result.length !== siblings.length) {
    return {
      sorted: [...siblings].sort((a, b) => (orderMap.get(a.taskId) ?? 0) - (orderMap.get(b.taskId) ?? 0)),
      cyclic: true
    };
  }

  const byId = new Map(siblings.map((task) => [task.taskId, task]));
  return {
    sorted: result.map((taskId) => byId.get(taskId) as EditableWorkflowTask),
    cyclic: false
  };
}

function buildTree(tasks: EditableWorkflowTask[]) {
  const idSet = new Set(tasks.map((task) => task.taskId));
  const groupMap = new Map<string, EditableWorkflowTask[]>();
  const orderMap = new Map(tasks.map((task, index) => [task.taskId, index]));
  let hasSiblingCycle = false;

  for (const task of tasks) {
    const parent = task.parentTaskId && idSet.has(task.parentTaskId) ? task.parentTaskId : ROOT_KEY;
    const group = groupMap.get(parent) ?? [];
    group.push(task);
    groupMap.set(parent, group);
  }

  const sortedGroupMap = new Map<string, EditableWorkflowTask[]>();
  for (const [parentId, siblings] of groupMap.entries()) {
    const sorted = topologicalSortSibling(siblings, orderMap);
    sortedGroupMap.set(parentId, sorted.sorted);
    hasSiblingCycle = hasSiblingCycle || sorted.cyclic;
  }

  return {
    roots: sortedGroupMap.get(ROOT_KEY) ?? [],
    childrenMap: sortedGroupMap,
    hasSiblingCycle
  };
}

function TemplateTaskNode({
  task,
  childrenMap,
  expanded,
  selectedTaskId,
  depth,
  onToggle,
  onSelect
}: {
  task: EditableWorkflowTask;
  childrenMap: Map<string, EditableWorkflowTask[]>;
  expanded: Set<string>;
  selectedTaskId: string | null;
  depth: number;
  onToggle: (taskId: string) => void;
  onSelect: (taskId: string) => void;
}) {
  const children = childrenMap.get(task.taskId) ?? [];
  const hasChildren = children.length > 0;
  const isExpanded = expanded.has(task.taskId);
  const isSelected = selectedTaskId === task.taskId;

  return (
    <div>
      <div
        style={{
          marginLeft: depth * 14,
          padding: "8px 10px",
          borderRadius: "8px",
          border: isSelected ? "1px solid var(--accent-primary)" : "1px solid var(--border-color)",
          background: isSelected ? "var(--accent-primary)20" : "var(--bg-elevated)",
          display: "flex",
          alignItems: "flex-start",
          gap: "8px",
          cursor: "pointer"
        }}
        onClick={() => onSelect(task.taskId)}
      >
        {hasChildren ? (
          <button
            className="btn btn-secondary btn-sm"
            style={{ minWidth: "22px", width: "22px", height: "22px", padding: 0 }}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(task.taskId);
            }}
          >
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "999px",
              background: "var(--text-muted)",
              marginLeft: "6px",
              marginTop: "6px",
              display: "inline-block"
            }}
          />
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: "14px",
              lineHeight: 1.25,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}
          >
            {task.title}
          </div>
          <div
            style={{
              fontSize: "12px",
              color: "var(--text-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}
          >
            {task.ownerRole}
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            <code>{task.taskId}</code>
          </div>
        </div>
      </div>
      {hasChildren &&
        isExpanded &&
        children.map((child) => (
          <TemplateTaskNode
            key={child.taskId}
            task={child}
            childrenMap={childrenMap}
            expanded={expanded}
            selectedTaskId={selectedTaskId}
            depth={depth + 1}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

export function WorkflowTemplateEditorView({ templateId }: WorkflowTemplateEditorViewProps) {
  const isEditMode = Boolean(templateId);
  const [loading, setLoading] = useState(Boolean(templateId));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null);
  const [registeredAgentIds, setRegisteredAgentIds] = useState<string[]>([]);
  const [teams, setTeams] = useState<Array<{ teamId: string; name: string }>>([]);
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [importingTeam, setImportingTeam] = useState(false);
  const [activeTeamAgentIds, setActiveTeamAgentIds] = useState<string[]>([]);

  const [templateIdInput, setTemplateIdInput] = useState(templateId ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tasks, setTasks] = useState<EditableWorkflowTask[]>([]);
  const [routeTable, setRouteTable] = useState<Record<string, string[]>>({});
  const [taskAssignRouteTable, setTaskAssignRouteTable] = useState<Record<string, string[]>>({});
  const [routeDiscussRounds, setRouteDiscussRounds] = useState<Record<string, Record<string, number>>>({});
  const [variableRows, setVariableRows] = useState<KeyValueRow[]>([{ key: "", value: "" }]);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskIdDraft, setTaskIdDraft] = useState("");
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let closed = false;
    async function loadAgents() {
      try {
        const payload = await agentApi.list();
        if (closed) {
          return;
        }
        setRegisteredAgentIds((payload.items ?? []).map((item) => item.agentId));
        setAgentLoadError(null);
      } catch (err) {
        if (!closed) {
          setAgentLoadError(err instanceof Error ? err.message : "Failed to load agent registry");
        }
      }
    }
    loadAgents();
    return () => {
      closed = true;
    };
  }, []);

  useEffect(() => {
    let closed = false;
    async function loadTeams() {
      setTeamLoading(true);
      try {
        const payload = await teamApi.list();
        if (closed) {
          return;
        }
        setTeams((payload.items ?? []).map((team) => ({ teamId: team.teamId, name: team.name })));
        setTeamError(null);
      } catch (err) {
        if (!closed) {
          setTeamError(err instanceof Error ? err.message : "Failed to load teams");
        }
      } finally {
        if (!closed) {
          setTeamLoading(false);
        }
      }
    }
    loadTeams();
    return () => {
      closed = true;
    };
  }, []);

  useEffect(() => {
    let closed = false;
    async function loadSelectedTeamAgents() {
      if (!selectedTeamId) {
        setActiveTeamAgentIds([]);
        return;
      }
      try {
        const team = await teamApi.get(selectedTeamId);
        if (closed) {
          return;
        }
        const teamAgentIds = Array.from(
          new Set((team.agentIds ?? []).map((item) => item.trim()).filter((item) => item.length > 0))
        );
        setActiveTeamAgentIds(teamAgentIds);
      } catch {
        if (!closed) {
          setActiveTeamAgentIds([]);
        }
      }
    }
    loadSelectedTeamAgents();
    return () => {
      closed = true;
    };
  }, [selectedTeamId]);

  useEffect(() => {
    const currentTemplateId = templateId;
    if (!currentTemplateId) {
      const task: EditableWorkflowTask = {
        taskId: "task_1",
        title: "New workflow task",
        ownerRole: ""
      };
      setTasks([task]);
      setSelectedTaskId(task.taskId);
      setExpandedTaskIds(new Set([task.taskId]));
      return;
    }
    const templateIdValue: string = currentTemplateId;
    let closed = false;
    async function loadTemplate() {
      setLoading(true);
      try {
        const payload = await workflowApi.getTemplate(templateIdValue);
        if (closed) {
          return;
        }
        const decodedTasks = (payload.tasks ?? []).map(decodeTaskMeta);
        setTemplateIdInput(payload.templateId);
        setName(payload.name);
        setDescription(payload.description ?? "");
        setTasks(decodedTasks);
        setRouteTable(payload.routeTable ?? {});
        setTaskAssignRouteTable(payload.taskAssignRouteTable ?? {});
        setRouteDiscussRounds(payload.routeDiscussRounds ?? {});
        setVariableRows(toRows(payload.defaultVariables));
        const firstTaskId = decodedTasks[0]?.taskId ?? null;
        setSelectedTaskId(firstTaskId);
        setExpandedTaskIds(new Set(decodedTasks.map((task) => task.taskId)));
        setError(null);
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load workflow template");
        }
      } finally {
        if (!closed) {
          setLoading(false);
        }
      }
    }
    loadTemplate();
    return () => {
      closed = true;
    };
  }, [templateId]);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.taskId === selectedTaskId) ?? null,
    [tasks, selectedTaskId]
  );
  const roles = useMemo(
    () => Array.from(new Set(tasks.map((task) => task.ownerRole.trim()).filter((role) => role.length > 0))),
    [tasks]
  );
  const roleOptions = useMemo(
    () =>
      Array.from(
        new Set(
          [...roles, ...(activeTeamAgentIds.length > 0 ? activeTeamAgentIds : registeredAgentIds)]
            .map((role) => role.trim())
            .filter((role) => role.length > 0)
        )
      ).sort((a, b) => a.localeCompare(b)),
    [roles, activeTeamAgentIds, registeredAgentIds]
  );
  const validationErrors = useMemo(() => validateTemplate(tasks), [tasks]);
  const tree = useMemo(() => buildTree(tasks), [tasks]);
  const registeredRoleSet = useMemo(
    () => new Set(registeredAgentIds.map((agentId) => agentId.toLowerCase())),
    [registeredAgentIds]
  );
  const activeTeamRoleSet = useMemo(
    () => new Set(activeTeamAgentIds.map((agentId) => agentId.toLowerCase())),
    [activeTeamAgentIds]
  );
  const overviewRoles = useMemo(
    () =>
      Array.from(
        new Set([...roles, ...activeTeamAgentIds].map((role) => role.trim()).filter((role) => role.length > 0))
      ).sort((a, b) => a.localeCompare(b)),
    [roles, activeTeamAgentIds]
  );

  useEffect(() => {
    setTaskIdDraft(selectedTask?.taskId ?? "");
  }, [selectedTask?.taskId]);

  const toggleExpand = (taskId: string) => {
    setExpandedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const expandAll = () => {
    setExpandedTaskIds(new Set(tasks.map((task) => task.taskId)));
  };

  const collapseAll = () => {
    setExpandedTaskIds(new Set());
  };

  const updateTask = (taskId: string, patch: Partial<EditableWorkflowTask>) => {
    setTasks((prev) => prev.map((task) => (task.taskId === taskId ? { ...task, ...patch } : task)));
  };

  const renameTaskId = (oldId: string, rawNextId: string) => {
    const nextId = rawNextId.trim();
    if (!nextId || nextId === oldId) {
      setTaskIdDraft(oldId);
      return;
    }
    if (tasks.some((task) => task.taskId === nextId)) {
      setError(`task_id '${nextId}' already exists`);
      setTaskIdDraft(oldId);
      return;
    }
    setTasks((prev) =>
      prev.map((task) => ({
        ...task,
        taskId: task.taskId === oldId ? nextId : task.taskId,
        parentTaskId: task.parentTaskId === oldId ? nextId : task.parentTaskId,
        dependencies: (task.dependencies ?? []).map((dep) => (dep === oldId ? nextId : dep))
      }))
    );
    setExpandedTaskIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        next.add(id === oldId ? nextId : id);
      }
      return next;
    });
    setSelectedTaskId(nextId);
    setTaskIdDraft(nextId);
    setError(null);
  };

  const addTask = (parentTaskId?: string) => {
    const taskId = createTaskId(tasks);
    const task: EditableWorkflowTask = {
      taskId,
      title: "New task",
      ownerRole: roles[0] ?? activeTeamAgentIds[0] ?? registeredAgentIds[0] ?? "",
      parentTaskId,
      dependencies: undefined,
      writeSet: undefined,
      acceptance: undefined,
      artifacts: undefined
    };
    setTasks((prev) => [...prev, task]);
    if (parentTaskId) {
      setExpandedTaskIds((prev) => {
        const next = new Set(prev);
        next.add(parentTaskId);
        return next;
      });
    }
    setSelectedTaskId(taskId);
  };

  const deleteTask = (taskId: string) => {
    if (!window.confirm(`Delete task '${taskId}'?`)) {
      return;
    }
    setTasks((prev) =>
      prev
        .filter((task) => task.taskId !== taskId)
        .map((task) => ({
          ...task,
          parentTaskId: task.parentTaskId === taskId ? undefined : task.parentTaskId,
          dependencies: (task.dependencies ?? []).filter((dep) => dep !== taskId)
        }))
    );
    setExpandedTaskIds((prev) => {
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
    setSelectedTaskId((prev) => {
      if (prev !== taskId) {
        return prev;
      }
      const parentTaskId = tasks.find((task) => task.taskId === taskId)?.parentTaskId;
      if (parentTaskId) {
        return parentTaskId;
      }
      const nextTask = tasks.find((task) => task.taskId !== taskId);
      return nextTask?.taskId ?? null;
    });
  };

  const toggleMatrixValue = (
    table: Record<string, string[]>,
    setTable: (table: Record<string, string[]>) => void,
    fromRole: string,
    toRole: string
  ) => {
    const current = table[fromRole] ?? [];
    const next = current.includes(toRole) ? current.filter((role) => role !== toRole) : [...current, toRole];
    setTable({ ...table, [fromRole]: next });
  };

  const importTeamConfig = async () => {
    if (!selectedTeamId) {
      setError("Select a team to import");
      return;
    }
    setImportingTeam(true);
    try {
      const team = await teamApi.get(selectedTeamId);
      const teamAgentIds = Array.from(
        new Set((team.agentIds ?? []).map((item) => item.trim()).filter((item) => item.length > 0))
      );
      setActiveTeamAgentIds(teamAgentIds);
      setRouteTable(team.routeTable ?? {});
      setTaskAssignRouteTable(team.taskAssignRouteTable ?? {});
      setRouteDiscussRounds(team.routeDiscussRounds ?? {});
      if (teamAgentIds.length > 0) {
        const roleMap = alignRolesToTeamAgents(
          Array.from(new Set(tasks.map((task) => task.ownerRole.trim()).filter((role) => role.length > 0))),
          teamAgentIds
        );
        if (roleMap.size > 0) {
          setTasks((prev) =>
            prev.map((task) => {
              const normalizedRole = task.ownerRole.trim();
              const mapped = roleMap.get(normalizedRole);
              if (!mapped || mapped === task.ownerRole) {
                return task;
              }
              return { ...task, ownerRole: mapped };
            })
          );
        }
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import team config");
    } finally {
      setImportingTeam(false);
    }
  };

  const onSave = async () => {
    setError(null);
    setSavedAt(null);

    const errors = validateTemplate(tasks);
    if (errors.length > 0 || tree.hasSiblingCycle) {
      setError(errors[0] ?? "Sibling dependency cycle detected in task tree.");
      return;
    }

    const finalTemplateId = templateIdInput.trim();
    if (!finalTemplateId) {
      setError("template_id is required");
      return;
    }
    if (!name.trim()) {
      setError("name is required");
      return;
    }

    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      tasks: tasks.map((task) => {
        const encoded = encodeTaskMeta(task);
        return {
          task_id: encoded.taskId,
          title: encoded.title,
          owner_role: encoded.ownerRole,
          parent_task_id: encoded.parentTaskId?.trim() || undefined,
          dependencies: encoded.dependencies,
          write_set: encoded.writeSet,
          acceptance: encoded.acceptance,
          artifacts: encoded.artifacts
        };
      }),
      route_table: routeTable,
      task_assign_route_table: taskAssignRouteTable,
      route_discuss_rounds: routeDiscussRounds,
      default_variables: rowsToMap(variableRows)
    };

    setSaving(true);
    try {
      if (isEditMode && templateId) {
        await workflowApi.patchTemplate(templateId, payload);
      } else {
        await workflowApi.createTemplate({
          template_id: finalTemplateId,
          ...payload
        });
        window.location.hash = `#/workflow/templates/${finalTemplateId}/edit`;
      }
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save workflow template");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>{isEditMode ? "Edit Workflow Template" : "Create Workflow Template"}</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>Loading template...</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>{isEditMode ? `Template: ${templateId}` : "Create Workflow Template"}</h1>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn btn-primary" onClick={onSave} disabled={saving}>
            <Save size={14} /> {saving ? "Saving..." : "Save"}
          </button>
          <a className="btn btn-secondary" href="#/workflow/templates">
            <ArrowLeft size={14} /> Back to Templates
          </a>
        </div>
      </div>

      <div style={{ overflow: "auto", paddingRight: "8px" }}>
        {error && <div className="error-message">{error}</div>}
        {savedAt && <div className="success-message">Saved at {savedAt}</div>}

        <div className="card">
          <div className="grid grid-2">
            <div className="form-group">
              <label>template_id *</label>
              <input
                value={templateIdInput}
                onChange={(e) => setTemplateIdInput(e.target.value)}
                readOnly={isEditMode}
                style={isEditMode ? { opacity: 0.8 } : undefined}
              />
            </div>
            <div className="form-group">
              <label>name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label>description</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Team Settings</h3>
          </div>
          <div className="grid grid-2" style={{ alignItems: "stretch" }}>
            <div className="card" style={{ padding: "12px", marginBottom: 0 }}>
              <div className="card-header">
                <h3>Import From Team</h3>
              </div>
              {teamError && <div className="error-message">{teamError}</div>}
              <div className="form-group">
                <label>Team</label>
                <select
                  value={selectedTeamId}
                  onChange={(e) => setSelectedTeamId(e.target.value)}
                  disabled={teamLoading}
                >
                  <option value="">Select team...</option>
                  {teams.map((team) => (
                    <option key={team.teamId} value={team.teamId}>
                      {team.name} ({team.teamId})
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={importTeamConfig}
                disabled={!selectedTeamId || importingTeam}
              >
                {importingTeam ? "Importing..." : "Import Routing & Assign"}
              </button>
              <p style={{ marginTop: "8px", fontSize: "12px", color: "var(--text-muted)" }}>
                Importing updates routing/assignment/discuss rounds and rewrites task owner_role to the imported team
                agents.
              </p>
              {activeTeamAgentIds.length > 0 && (
                <div style={{ marginTop: "8px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {activeTeamAgentIds.map((agentId) => (
                    <span key={agentId} className="badge badge-neutral">
                      {agentId}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="card" style={{ padding: "12px", marginBottom: 0 }}>
              <div className="card-header">
                <h3>Role-Agent Overview</h3>
              </div>
              {agentLoadError && <div className="error-message">{agentLoadError}</div>}
              {overviewRoles.length === 0 ? (
                <p style={{ color: "var(--text-muted)" }}>No roles yet.</p>
              ) : (
                <div className="table-container">
                  <table>
                    <thead>
                      <tr>
                        <th>Role</th>
                        <th>Task Count</th>
                        <th>Registered</th>
                        <th>In Imported Team</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overviewRoles.map((role) => {
                        const ready = registeredRoleSet.has(role.toLowerCase());
                        const inTeam = activeTeamRoleSet.has(role.toLowerCase());
                        return (
                          <tr key={`role-${role}`}>
                            <td>
                              <code>{role}</code>
                            </td>
                            <td>{tasks.filter((task) => task.ownerRole.trim() === role).length}</td>
                            <td>
                              <span className={`badge ${ready ? "badge-success" : "badge-danger"}`}>
                                {ready ? "registered" : "missing"}
                              </span>
                            </td>
                            <td>
                              {activeTeamAgentIds.length === 0 ? (
                                <span className="badge badge-neutral">n/a</span>
                              ) : (
                                <span className={`badge ${inTeam ? "badge-success" : "badge-warning"}`}>
                                  {inTeam ? "in team" : "not in team"}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-2" style={{ alignItems: "stretch", marginTop: "12px" }}>
            <div className="card" style={{ padding: "12px", marginBottom: 0 }}>
              <div className="card-header">
                <h3>Message Route Matrix</h3>
              </div>
              {roles.length <= 1 ? (
                <p style={{ color: "var(--text-muted)" }}>Need at least two roles to configure routing.</p>
              ) : (
                roles.map((fromRole) => (
                  <div key={`route-${fromRole}`} style={{ marginBottom: "8px" }}>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "4px" }}>{fromRole}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                      {roles
                        .filter((toRole) => toRole !== fromRole)
                        .map((toRole) => {
                          const enabled = (routeTable[fromRole] ?? []).includes(toRole);
                          const rounds = routeDiscussRounds[fromRole]?.[toRole] ?? 3;
                          return (
                            <div
                              key={`${fromRole}-${toRole}`}
                              style={{ display: "flex", alignItems: "center", gap: "6px" }}
                            >
                              <label style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  onChange={() => toggleMatrixValue(routeTable, setRouteTable, fromRole, toRole)}
                                />
                                <span style={{ fontSize: "12px" }}>{toRole}</span>
                              </label>
                              <input
                                type="number"
                                min={1}
                                max={100}
                                value={rounds}
                                onChange={(e) => {
                                  const parsed = Math.max(1, Math.min(100, Number(e.target.value) || 1));
                                  setRouteDiscussRounds((prev) => ({
                                    ...prev,
                                    [fromRole]: {
                                      ...(prev[fromRole] ?? {}),
                                      [toRole]: parsed
                                    }
                                  }));
                                }}
                                style={{ width: "62px" }}
                              />
                            </div>
                          );
                        })}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="card" style={{ padding: "12px", marginBottom: 0 }}>
              <div className="card-header">
                <h3>Task Assign Matrix</h3>
              </div>
              {roles.length <= 1 ? (
                <p style={{ color: "var(--text-muted)" }}>Need at least two roles to configure assignment.</p>
              ) : (
                roles.map((fromRole) => (
                  <div key={`assign-${fromRole}`} style={{ marginBottom: "8px" }}>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "4px" }}>{fromRole}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                      {roles
                        .filter((toRole) => toRole !== fromRole)
                        .map((toRole) => {
                          const enabled = (taskAssignRouteTable[fromRole] ?? []).includes(toRole);
                          return (
                            <label
                              key={`${fromRole}-${toRole}`}
                              style={{ display: "flex", alignItems: "center", gap: "4px" }}
                            >
                              <input
                                type="checkbox"
                                checked={enabled}
                                onChange={() =>
                                  toggleMatrixValue(taskAssignRouteTable, setTaskAssignRouteTable, fromRole, toRole)
                                }
                              />
                              <span style={{ fontSize: "12px" }}>{toRole}</span>
                            </label>
                          );
                        })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Task Builder</h3>
          </div>
          <div className="grid grid-2" style={{ alignItems: "stretch", minHeight: 0 }}>
            <div className="card" data-scrollable style={{ marginBottom: 0 }}>
              <div className="card-header">
                <h3>Task Tree</h3>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button className="btn btn-primary btn-sm" onClick={() => addTask(selectedTaskId ?? undefined)}>
                    <Plus size={14} /> Add Child
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => addTask(undefined)}>
                    <Plus size={14} /> Add Root
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={expandAll}>
                    Expand All
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={collapseAll}>
                    Collapse All
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => selectedTaskId && deleteTask(selectedTaskId)}
                    disabled={!selectedTaskId}
                  >
                    <Trash2 size={14} /> Delete Selected
                  </button>
                </div>
              </div>
              {tree.roots.length === 0 ? (
                <div className="empty-state" style={{ padding: "24px" }}>
                  <p>No tasks yet. Create your first task.</p>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {tree.roots.map((task) => (
                    <TemplateTaskNode
                      key={task.taskId}
                      task={task}
                      childrenMap={tree.childrenMap}
                      expanded={expandedTaskIds}
                      selectedTaskId={selectedTaskId}
                      depth={0}
                      onToggle={toggleExpand}
                      onSelect={(taskId) => {
                        setSelectedTaskId(taskId);
                        setExpandedTaskIds((prev) => new Set(prev).add(taskId));
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="card" data-scrollable style={{ marginBottom: 0 }}>
              <div className="card-header">
                <h3>Task Detail</h3>
              </div>
              {!selectedTask ? (
                <div className="empty-state" style={{ padding: "24px" }}>
                  <p>Select a task node to edit.</p>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <div style={{ padding: "10px 12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
                    <div style={{ fontSize: "15px", fontWeight: 700, lineHeight: 1.2 }}>{selectedTask.title}</div>
                    <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
                      {selectedTask.ownerRole}
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>
                      <code>{selectedTask.taskId}</code>
                    </div>
                  </div>
                  <div className="form-group">
                    <label>task_id *</label>
                    <input
                      value={taskIdDraft}
                      onChange={(e) => setTaskIdDraft(e.target.value)}
                      onBlur={() => renameTaskId(selectedTask.taskId, taskIdDraft)}
                    />
                  </div>
                  <div className="form-group">
                    <label>title *</label>
                    <input
                      value={selectedTask.title}
                      onChange={(e) => updateTask(selectedTask.taskId, { title: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>owner_role (assign) *</label>
                    <input
                      list="workflow-role-options"
                      value={selectedTask.ownerRole}
                      onChange={(e) => updateTask(selectedTask.taskId, { ownerRole: e.target.value })}
                    />
                    <datalist id="workflow-role-options">
                      {roleOptions.map((role) => (
                        <option key={role} value={role} />
                      ))}
                    </datalist>
                  </div>
                  <div className="form-group">
                    <label>parent_task_id</label>
                    <select
                      value={selectedTask.parentTaskId ?? ""}
                      onChange={(e) => updateTask(selectedTask.taskId, { parentTaskId: e.target.value || undefined })}
                    >
                      <option value="">(root)</option>
                      {tasks
                        .filter((task) => task.taskId !== selectedTask.taskId)
                        .map((task) => (
                          <option key={task.taskId} value={task.taskId}>
                            {task.taskId}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>summary (metadata)</label>
                    <textarea
                      rows={2}
                      value={selectedTask.summary ?? ""}
                      onChange={(e) => updateTask(selectedTask.taskId, { summary: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>prompt (metadata)</label>
                    <textarea
                      rows={4}
                      value={selectedTask.prompt ?? ""}
                      onChange={(e) => updateTask(selectedTask.taskId, { prompt: e.target.value })}
                    />
                    <div style={{ marginTop: "4px", fontSize: "11px", color: "var(--text-muted)" }}>
                      Stored via <code>artifacts</code> reserved metadata entry.
                    </div>
                  </div>
                  <div className="form-group">
                    <label>dependencies (comma or newline separated)</label>
                    <textarea
                      rows={2}
                      value={(selectedTask.dependencies ?? []).join(", ")}
                      onChange={(e) => updateTask(selectedTask.taskId, { dependencies: splitTextList(e.target.value) })}
                    />
                  </div>
                  <div className="form-group">
                    <label>writeSet</label>
                    <textarea
                      rows={2}
                      value={(selectedTask.writeSet ?? []).join(", ")}
                      onChange={(e) => updateTask(selectedTask.taskId, { writeSet: splitTextList(e.target.value) })}
                    />
                  </div>
                  <div className="form-group">
                    <label>acceptance</label>
                    <textarea
                      rows={2}
                      value={(selectedTask.acceptance ?? []).join(", ")}
                      onChange={(e) => updateTask(selectedTask.taskId, { acceptance: splitTextList(e.target.value) })}
                    />
                  </div>
                  <div className="form-group">
                    <label>artifacts (business artifacts only)</label>
                    <textarea
                      rows={2}
                      value={(selectedTask.artifacts ?? []).join(", ")}
                      onChange={(e) => updateTask(selectedTask.taskId, { artifacts: splitTextList(e.target.value) })}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Run Defaults & Validation</h3>
          </div>
          <p style={{ marginBottom: "12px", fontSize: "12px", color: "var(--text-muted)" }}>
            default_variables are injected when creating a workflow run. Validation shows issues that block saving.
          </p>
          <div className="grid grid-2" style={{ alignItems: "stretch" }}>
            <div className="card" style={{ padding: "12px", marginBottom: 0 }}>
              <div className="card-header">
                <h3>default_variables</h3>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setVariableRows((prev) => [...prev, { key: "", value: "" }])}
                >
                  <Plus size={14} /> Add
                </button>
              </div>
              {variableRows.map((row, index) => (
                <div
                  key={`var-${index}`}
                  style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "8px", marginBottom: "8px" }}
                >
                  <input
                    placeholder="key"
                    value={row.key}
                    onChange={(e) => {
                      const next = [...variableRows];
                      next[index] = { ...row, key: e.target.value };
                      setVariableRows(next);
                    }}
                  />
                  <input
                    placeholder="value"
                    value={row.value}
                    onChange={(e) => {
                      const next = [...variableRows];
                      next[index] = { ...row, value: e.target.value };
                      setVariableRows(next);
                    }}
                  />
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => setVariableRows((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            <div className="card" style={{ padding: "12px", marginBottom: 0 }}>
              <div className="card-header">
                <h3>Validation</h3>
              </div>
              {validationErrors.length === 0 && !tree.hasSiblingCycle ? (
                <div className="success-message" style={{ marginBottom: 0 }}>
                  Template validation passed.
                </div>
              ) : (
                <ul style={{ paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "6px" }}>
                  {validationErrors.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                  {tree.hasSiblingCycle && <li>Sibling dependency cycle detected. Resolve sibling dependency loop.</li>}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
