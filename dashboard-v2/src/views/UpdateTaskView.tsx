import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "@/hooks/i18n";
import type {
  ProjectDetail,
  SessionRecord,
  TaskTreeNode,
  LockRecord,
  EventRecord,
  AgentIOTimelineItem,
  TaskState,
  TaskDetail
} from "@/types";
import { projectApi } from "@/services/api";
import { Save, Loader, Search, FileText } from "lucide-react";

import { TaskDetailsModal } from "./TaskDetailsModal";

interface UpdateTaskViewProps {
  projectId: string;
  project: ProjectDetail | null;
  sessions: SessionRecord[];
  tasks: TaskTreeNode[];
  locks: LockRecord[];
  events: EventRecord[];
  timeline: AgentIOTimelineItem[];
  reload: () => void;
}

export function UpdateTaskView({ projectId, project, tasks, timeline, reload }: UpdateTaskViewProps) {
  const t = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [state, setState] = useState<TaskState | "">("");
  const [ownerRole, setOwnerRole] = useState("");
  const [writeSet, setWriteSet] = useState("");
  const [dependencies, setDependencies] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const filteredTasks = useMemo(() => {
    if (!searchQuery) return tasks.slice(0, 50);
    const q = searchQuery.toLowerCase();
    return tasks.filter((tsk) => tsk.task_id.toLowerCase().includes(q) || tsk.title.toLowerCase().includes(q));
  }, [tasks, searchQuery]);

  const selectedTask = tasks.find((tsk) => tsk.task_id === selectedTaskId);

  // Fetch task detail when task is selected
  useEffect(() => {
    if (!selectedTaskId || !projectId) {
      setTaskDetail(null);
      return;
    }
    projectApi
      .getTaskDetail(projectId, selectedTaskId)
      .then(setTaskDetail)
      .catch(() => setTaskDetail(null));
  }, [projectId, selectedTaskId]);

  // Extract content from create_parameters
  const createParamsContent = taskDetail?.create_parameters?.content as string | undefined;

  const handleSelectTask = (taskId: string) => {
    const tsk = tasks.find((tsk2) => tsk2.task_id === taskId);
    if (tsk) {
      setSelectedTaskId(taskId);
      setState(tsk.state);
      setOwnerRole(tsk.owner_role);
      setWriteSet(tsk.write_set.join("\n"));
      setDependencies(tsk.dependencies.join("\n"));
      setAcceptance(tsk.acceptance.join("\n"));
    }
  };

  async function onUpdate() {
    if (!selectedTaskId) return;
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      const writeSetArr = writeSet
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const dependenciesArr = dependencies
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const acceptanceArr = acceptance
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      await projectApi.patchTask(projectId, selectedTaskId, {
        state: state || undefined,
        owner_role: ownerRole || undefined,
        write_set: writeSetArr.length > 0 ? writeSetArr : undefined,
        dependencies: dependenciesArr.length > 0 ? dependenciesArr : undefined,
        acceptance: acceptanceArr.length > 0 ? acceptanceArr : undefined
      });

      setSuccess(`Task updated: ${selectedTaskId}`);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update task");
    } finally {
      setSaving(false);
    }
  }

  const agentRoles = project?.agentIds ?? [];

  return (
    <section>
      <div className="page-header">
        <h1>{t.updateTask}</h1>
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="card">
          <div className="card-header">
            <h3>Select Task</h3>
            <span className="badge badge-neutral">{filteredTasks.length}</span>
          </div>
          <div className="form-group" style={{ marginBottom: "12px" }}>
            <div style={{ position: "relative" }}>
              <Search
                size={16}
                style={{
                  position: "absolute",
                  left: "12px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--text-muted)"
                }}
              />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tasks..."
                style={{ paddingLeft: "36px" }}
              />
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              maxHeight: "calc(100vh - 320px)",
              overflow: "auto"
            }}
          >
            {filteredTasks.map((tsk) => (
              <button
                key={tsk.task_id}
                className={`btn ${selectedTaskId === tsk.task_id ? "btn-primary" : "btn-secondary"}`}
                style={{ justifyContent: "flex-start", textAlign: "left" }}
                onClick={() => handleSelectTask(tsk.task_id)}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: "13px" }}>{tsk.title}</div>
                  <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                    {tsk.task_id.slice(0, 24)}... | {tsk.state}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          {selectedTask ? (
            <>
              <div className="card-header">
                <h3>{t.taskDetails}</h3>
                <span className="badge badge-neutral">{selectedTask.state}</span>
              </div>

              <div className="form-group">
                <label>{t.taskTitle}</label>
                <input value={selectedTask.title} disabled style={{ opacity: 0.7 }} />
              </div>

              {/* Content field from create_parameters */}
              {createParamsContent && (
                <div className="form-group">
                  <label>Content</label>
                  <div
                    onClick={() => setIsModalOpen(true)}
                    style={{
                      padding: "12px",
                      background: "var(--bg-elevated)",
                      borderRadius: "8px",
                      cursor: "pointer",
                      border: "1px solid var(--border-color)",
                      transition: "all 0.15s",
                      maxHeight: "120px",
                      overflow: "hidden",
                      position: "relative"
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "var(--accent-primary)";
                      e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "var(--border-color)";
                      e.currentTarget.style.background = "var(--bg-elevated)";
                    }}
                  >
                    <div
                      style={{
                        fontSize: "13px",
                        color: "var(--text-secondary)",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word"
                      }}
                    >
                      {createParamsContent.length > 200
                        ? createParamsContent.slice(0, 200) + "..."
                        : createParamsContent}
                    </div>
                    <div
                      style={{
                        position: "absolute",
                        bottom: 0,
                        right: 0,
                        padding: "4px 8px",
                        background: "var(--bg-elevated)",
                        borderTopLeftRadius: "4px",
                        fontSize: "11px",
                        color: "var(--text-muted)",
                        display: "flex",
                        alignItems: "center",
                        gap: "4px"
                      }}
                    >
                      <FileText size={12} />
                      Click to view full params
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-2">
                <div className="form-group">
                  <label>{t.taskState}</label>
                  <select value={state} onChange={(e) => setState(e.target.value as TaskState)}>
                    <option value="">No change</option>
                    <option value="PLANNED">Planned</option>
                    <option value="READY">Ready</option>
                    <option value="DISPATCHED">Dispatched</option>
                    <option value="IN_PROGRESS">In Progress</option>
                    <option value="BLOCKED_DEP">Blocked (Dependency)</option>
                    <option value="MAY_BE_DONE">May Be Done</option>
                    <option value="DONE">Done</option>
                    <option value="CANCELED">Canceled</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>{t.ownerRole}</label>
                  <select value={ownerRole} onChange={(e) => setOwnerRole(e.target.value)}>
                    <option value="">No change</option>
                    {agentRoles.map((role) => (
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
                  style={{ minHeight: "60px" }}
                />
              </div>

              <div className="form-group">
                <label>{t.dependencies}</label>
                <textarea
                  value={dependencies}
                  onChange={(e) => setDependencies(e.target.value)}
                  style={{ minHeight: "60px" }}
                />
              </div>

              <div className="form-group">
                <label>{t.acceptance}</label>
                <textarea
                  value={acceptance}
                  onChange={(e) => setAcceptance(e.target.value)}
                  style={{ minHeight: "60px" }}
                />
              </div>

              <div style={{ marginTop: "20px" }}>
                <button className="btn btn-primary btn-lg" disabled={saving} onClick={onUpdate}>
                  {saving ? <Loader size={18} className="loading-spinner" /> : <Save size={18} />}
                  {saving ? t.saving : t.save}
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state" style={{ padding: "32px" }}>
              <p>Select a task to update</p>
            </div>
          )}
        </div>
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

      {/* Create Params Modal */}
      <TaskDetailsModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        createParams={taskDetail?.create_parameters}
        timeline={timeline}
      />
    </section>
  );
}
