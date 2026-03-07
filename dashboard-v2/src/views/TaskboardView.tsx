import { useMemo, useState } from "react";
import { useTranslation } from "@/hooks/i18n";
import type {
  ProjectDetail,
  SessionRecord,
  TaskTreeNode,
  TaskState,
  LockRecord,
  EventRecord,
  AgentIOTimelineItem
} from "@/types";
import { projectApi } from "@/services/api";
import { Play, Loader } from "lucide-react";

interface TaskboardViewProps {
  projectId: string;
  project: ProjectDetail | null;
  sessions: SessionRecord[];
  tasks: TaskTreeNode[];
  locks: LockRecord[];
  events: EventRecord[];
  timeline: AgentIOTimelineItem[];
  reload: () => void;
}

export function TaskboardView({ projectId, sessions, tasks, reload }: TaskboardViewProps) {
  const t = useTranslation();
  const [dispatchingTaskId, setDispatchingTaskId] = useState<string | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [dispatchSuccess, setDispatchSuccess] = useState<string | null>(null);

  async function handleForceDispatch(task: TaskTreeNode) {
    const session = sessions.find((s) => s.role === task.owner_role && s.status !== "dismissed");

    setDispatchingTaskId(task.task_id);
    setDispatchError(null);
    setDispatchSuccess(null);

    try {
      const result = await projectApi.dispatch(projectId, {
        session_id: session?.sessionId,
        task_id: task.task_id,
        force: true,
        only_idle: false
      });

      if (result.results && result.results.length > 0) {
        const r = result.results[0];
        if (r.outcome === "dispatched") {
          setDispatchSuccess(`Task ${task.title} dispatched successfully`);
          reload();
        } else {
          setDispatchError(`Dispatch outcome: ${r.outcome}${r.reason ? ` - ${r.reason}` : ""}`);
        }
      }
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : "Failed to dispatch");
    } finally {
      setDispatchingTaskId(null);
    }
  }

  const taskStateGroups: Record<string, TaskState[]> = {
    Backlog: ["PLANNED"],
    Ready: ["READY"],
    "In Progress": ["DISPATCHED", "IN_PROGRESS"],
    Blocked: ["BLOCKED_DEP"],
    "May Be Done": ["MAY_BE_DONE"],
    Done: ["DONE", "CANCELED"]
  };

  const stateLabels: Record<TaskState, string> = {
    PLANNED: t.taskPlanned,
    READY: t.taskReady,
    DISPATCHED: t.taskDispatched,
    IN_PROGRESS: t.taskInProgress,
    BLOCKED_DEP: t.taskBlockedDep,
    MAY_BE_DONE: t.taskMayBeDone ?? "May Be Done",
    DONE: t.taskDone,
    CANCELED: t.taskCanceled
  };

  const stateColors: Record<TaskState, string> = {
    PLANNED: "var(--text-muted)",
    READY: "var(--accent-primary)",
    DISPATCHED: "var(--accent-secondary)",
    IN_PROGRESS: "var(--accent-warning)",
    BLOCKED_DEP: "var(--accent-danger)",
    MAY_BE_DONE: "var(--accent-success)",
    DONE: "var(--accent-success)",
    CANCELED: "var(--text-muted)"
  };

  const groupedTasks = useMemo(() => {
    const groups: Record<string, TaskTreeNode[]> = {};
    for (const [groupName, states] of Object.entries(taskStateGroups)) {
      groups[groupName] = tasks.filter((task) => states.includes(task.state));
    }
    return groups;
  }, [tasks]);

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <h1>{t.taskboard}</h1>
      </div>

      {dispatchError && (
        <div className="error-message" style={{ flexShrink: 0 }}>
          {dispatchError}
        </div>
      )}
      {dispatchSuccess && (
        <div className="success-message" style={{ flexShrink: 0 }}>
          {dispatchSuccess}
        </div>
      )}

      <div className="card" style={{ marginBottom: "16px", flexShrink: 0 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            gap: "12px",
            marginBottom: "16px"
          }}
        >
          <StatCard label="Total" value={tasks.length} />
          <StatCard label="In Progress" value={groupedTasks["In Progress"].length} color="var(--accent-warning)" />
          <StatCard label="Done" value={groupedTasks["Done"].length} color="var(--accent-success)" />
          <StatCard label="Blocked" value={groupedTasks["Blocked"].length} color="var(--accent-danger)" />
          <StatCard label="May Be Done" value={groupedTasks["May Be Done"].length} color="var(--accent-success)" />
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "16px",
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          paddingRight: "4px"
        }}
      >
        {Object.entries(groupedTasks).map(([groupName, groupTasks]) => (
          <div
            key={groupName}
            className="card"
            style={{ flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
            <div className="card-header" style={{ flexShrink: 0 }}>
              <h3>{groupName}</h3>
              <span className="badge badge-neutral">{groupTasks.length}</span>
            </div>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "8px", flex: 1, minHeight: 0, overflow: "auto" }}
            >
              {groupTasks.length === 0 ? (
                <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)" }}>No tasks</div>
              ) : (
                groupTasks.map((task) => (
                  <TaskCard
                    key={task.task_id}
                    task={task}
                    stateLabels={stateLabels}
                    stateColors={stateColors}
                    onForceDispatch={handleForceDispatch}
                    isDispatching={dispatchingTaskId === task.task_id}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div
      style={{
        padding: "12px",
        background: "var(--bg-elevated)",
        borderRadius: "8px",
        textAlign: "center"
      }}
    >
      <div style={{ fontSize: "24px", fontWeight: 700, color: color ?? "var(--text-primary)" }}>{value}</div>
      <div style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase" }}>{label}</div>
    </div>
  );
}

function TaskCard({
  task,
  stateLabels,
  stateColors,
  onForceDispatch,
  isDispatching
}: {
  task: TaskTreeNode;
  stateLabels: Record<TaskState, string>;
  stateColors: Record<TaskState, string>;
  onForceDispatch: (task: TaskTreeNode) => void;
  isDispatching: boolean;
}) {
  const canDispatch = !["DONE", "CANCELED"].includes(task.state);

  return (
    <div
      style={{
        padding: "12px",
        background: "var(--bg-elevated)",
        borderRadius: "8px",
        borderLeft: `3px solid ${stateColors[task.state]}`
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
        <div style={{ fontWeight: 600, fontSize: "13px", flex: 1 }}>{task.title}</div>
        {canDispatch && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => onForceDispatch(task)}
            disabled={isDispatching}
            title="Force dispatch this task"
            style={{ marginLeft: "8px", padding: "4px 8px" }}
          >
            {isDispatching ? <Loader size={12} className="loading-spinner" /> : <Play size={12} />}
          </button>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
        <span className="badge badge-neutral" style={{ fontSize: "10px" }}>
          {task.task_id.slice(0, 16)}...
        </span>
        <span style={{ fontSize: "11px", color: stateColors[task.state] }}>{stateLabels[task.state]}</span>
      </div>
      <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>Owner: {task.owner_role}</div>
      {task.last_summary && (
        <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "6px" }}>{task.last_summary}</div>
      )}
    </div>
  );
}
