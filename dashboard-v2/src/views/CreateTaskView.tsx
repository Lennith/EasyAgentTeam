import { useState } from "react";
import { useTranslation } from "@/hooks/i18n";
import type { ProjectDetail, SessionRecord, TaskTreeNode, LockRecord, EventRecord, AgentIOTimelineItem } from "@/types";
import { projectApi } from "@/services/api";
import { Plus, Loader, X } from "lucide-react";

interface CreateTaskViewProps {
  projectId: string;
  project: ProjectDetail | null;
  sessions: SessionRecord[];
  tasks: TaskTreeNode[];
  locks: LockRecord[];
  events: EventRecord[];
  timeline: AgentIOTimelineItem[];
  reload: () => void;
}

export function CreateTaskView({ projectId, project, sessions, tasks, reload }: CreateTaskViewProps) {
  const t = useTranslation();
  const [title, setTitle] = useState("");
  const [ownerRole, setOwnerRole] = useState("");
  const [parentTaskId, setParentTaskId] = useState<string>(() => {
    // Default to PROJECT_ROOT if exists
    const rootTask = tasks.find((tsk) => tsk.task_kind === "PROJECT_ROOT");
    return rootTask?.task_id ?? "";
  });
  const [writeSet, setWriteSet] = useState("");
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [acceptance, setAcceptance] = useState("");
  const [fromAgent, setFromAgent] = useState("manager");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const agentRoles = project?.agentIds ?? [];
  const sessionRoles = sessions.map((s) => s.role).filter((v, i, a) => a.indexOf(v) === i);
  const availableRoles = agentRoles.length > 0 ? agentRoles : sessionRoles;

  const rootTasks = tasks.filter((tsk) => tsk.task_kind === "PROJECT_ROOT" || tsk.task_kind === "USER_ROOT");
  const allTasks = tasks;

  const selectableDependencies = tasks.filter((tsk) => tsk.state !== "DONE" && tsk.state !== "CANCELED");

  function removeDependency(taskId: string) {
    setDependencies((prev) => prev.filter((id) => id !== taskId));
  }

  async function onCreate() {
    try {
      setCreating(true);
      setError(null);
      setSuccess(null);

      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const result = await projectApi.taskAction(projectId, {
        action_type: "TASK_CREATE",
        from_agent: fromAgent || "manager",
        to_role: ownerRole,
        payload: {
          task_id: taskId,
          title,
          parent_task_id: parentTaskId,
          owner_role: ownerRole,
          write_set: writeSet
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          dependencies: dependencies,
          acceptance: acceptance
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        }
      });

      setSuccess(`Task created: ${title} (ID: ${result.taskId ?? "auto-generated"})`);
      setTitle("");
      setWriteSet("");
      setDependencies([]);
      setAcceptance("");
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setCreating(false);
    }
  }

  return (
    <section>
      <div className="page-header">
        <h1>{t.createTask}</h1>
      </div>

      <div className="card">
        <div className="form-group">
          <label>{t.taskTitle} *</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Enter task title..." />
        </div>

        <div className="grid grid-2">
          <div className="form-group">
            <label>{t.parentTask} *</label>
            <select value={parentTaskId} onChange={(e) => setParentTaskId(e.target.value)}>
              <option value="">Select parent task...</option>
              {rootTasks.length === 0 && allTasks.length === 0 && (
                <option value="_loading" disabled>
                  Loading tasks...
                </option>
              )}
              {rootTasks.map((tsk) => (
                <option key={tsk.task_id} value={tsk.task_id}>
                  {tsk.title} ({tsk.task_kind})
                </option>
              ))}
              {allTasks
                .filter((tsk) => tsk.task_kind === "EXECUTION")
                .map((tsk) => (
                  <option key={tsk.task_id} value={tsk.task_id}>
                    {tsk.title}
                  </option>
                ))}
            </select>
          </div>

          <div className="form-group">
            <label>{t.ownerRole} *</label>
            <select value={ownerRole} onChange={(e) => setOwnerRole(e.target.value)}>
              <option value="">Select role...</option>
              {availableRoles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-2">
          <div className="form-group">
            <label>{t.fromAgent}</label>
            <select value={fromAgent} onChange={(e) => setFromAgent(e.target.value)}>
              <option value="manager">manager</option>
              {availableRoles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-group">
          <label>{t.writeSet}</label>
          <textarea
            value={writeSet}
            onChange={(e) => setWriteSet(e.target.value)}
            placeholder="One path per line..."
            style={{ minHeight: "60px" }}
          />
        </div>

        <div className="form-group">
          <label>{t.dependencies}</label>
          {dependencies.length > 0 && (
            <div style={{ marginBottom: "8px", display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {dependencies.map((depId) => {
                const depTask = tasks.find((t) => t.task_id === depId);
                return (
                  <span
                    key={depId}
                    className="badge"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      padding: "4px 8px",
                      background: "var(--color-primary-light)",
                      borderRadius: "4px",
                      fontSize: "12px"
                    }}
                  >
                    {depTask?.title ?? depId}
                    <button
                      type="button"
                      onClick={() => removeDependency(depId)}
                      style={{ background: "none", border: "none", cursor: "pointer", padding: "0", display: "flex" }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <select
            value=""
            onChange={(e) => {
              if (e.target.value && !dependencies.includes(e.target.value)) {
                setDependencies((prev) => [...prev, e.target.value]);
              }
            }}
          >
            <option value="">Select dependency to add...</option>
            {selectableDependencies.length === 0 && (
              <option value="" disabled>
                No available tasks
              </option>
            )}
            {selectableDependencies.map((tsk) => (
              <option key={tsk.task_id} value={tsk.task_id}>
                {tsk.title} ({tsk.state})
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>{t.acceptance}</label>
          <textarea
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            placeholder="One acceptance criteria per line..."
            style={{ minHeight: "60px" }}
          />
        </div>

        <div style={{ marginTop: "20px" }}>
          <button
            className="btn btn-primary btn-lg"
            disabled={creating || !title.trim() || !ownerRole.trim() || !parentTaskId}
            onClick={onCreate}
          >
            {creating ? <Loader size={18} className="loading-spinner" /> : <Plus size={18} />}
            {creating ? t.saving : t.create}
          </button>
        </div>

        {error && (
          <div className="error-message" style={{ marginTop: "16px" }}>
            {error}
          </div>
        )}
        {success && (
          <div className="success-message" style={{ marginTop: "16px" }}>
            {success}
          </div>
        )}
      </div>
    </section>
  );
}
