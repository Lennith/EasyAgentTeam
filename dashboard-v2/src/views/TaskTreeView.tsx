import { useMemo, useState, useEffect } from "react";
import { useTranslation } from "@/hooks/i18n";
import type {
  ProjectDetail,
  SessionRecord,
  TaskState,
  TaskKind,
  LockRecord,
  EventRecord,
  AgentIOTimelineItem,
  TaskTreeNode,
  TaskDetail,
  TaskLifecycleEvent
} from "@/types";
import { projectApi } from "@/services/api";
import { ChevronRight, ChevronDown, Circle, X, Loader, Play } from "lucide-react";
import { TaskDetailsModal } from "./TaskDetailsModal";

interface TaskTreeViewProps {
  projectId: string;
  project: ProjectDetail | null;
  sessions: SessionRecord[];
  tasks: TaskTreeNode[];
  locks: LockRecord[];
  events: EventRecord[];
  timeline: AgentIOTimelineItem[];
  reload: () => void;
  taskApi?: {
    getTaskDetail: (taskId: string) => Promise<TaskDetail>;
    forceDispatch: (args: { taskId: string; ownerRole: string; sessionId?: string }) => Promise<{
      outcome: "dispatched" | "no_task" | "session_busy" | "run_not_running" | "invalid_target";
      reason?: string;
    }>;
  };
}

export function TaskTreeView({
  projectId,
  sessions,
  tasks: propTasks,
  loading,
  error,
  reload,
  taskApi
}: TaskTreeViewProps & { loading?: boolean; error?: string | null }) {
  const t = useTranslation();

  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [dispatchSuccess, setDispatchSuccess] = useState<string | null>(null);
  const [selectedMinimaxLogs, setSelectedMinimaxLogs] = useState<TaskLifecycleEvent[] | null>(null);
  const [selectedCreateParams, setSelectedCreateParams] = useState<Record<string, unknown> | null>(null);

  const tasks = useMemo((): TaskTreeNode[] => {
    if (!propTasks || propTasks.length === 0) return [];
    return propTasks.map((task) => {
      const raw = task as unknown as Record<string, unknown>;
      return {
        ...task,
        task_kind: (task.task_kind ?? raw.kind ?? "EXECUTION") as TaskKind,
        state: (task.state ?? raw.task_state ?? "PLANNED") as TaskState,
        title: task.title ?? "Untitled Task",
        owner_role: task.owner_role ?? raw.ownerRole ?? "unknown"
      };
    });
  }, [propTasks]);

  const visibleTasks = useMemo(() => {
    return tasks.filter((task) => task.task_kind !== "PROJECT_ROOT" && task.task_kind !== "USER_ROOT");
  }, [tasks]);

  const hiddenTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of tasks) {
      if (task.task_kind === "PROJECT_ROOT" || task.task_kind === "USER_ROOT") {
        ids.add(task.task_id);
      }
    }
    return ids;
  }, [tasks]);

  useEffect(() => {
    if (!selectedTaskId) {
      setTaskDetail(null);
      return;
    }

    let closed = false;
    const selectedChanged = taskDetail?.task.task_id !== selectedTaskId;
    if (selectedChanged || !taskDetail) {
      setLoadingDetail(true);
    }
    const request = taskApi?.getTaskDetail
      ? taskApi.getTaskDetail(selectedTaskId)
      : projectApi.getTaskDetail(projectId, selectedTaskId);
    request
      .then((detail) => {
        if (!closed) setTaskDetail(detail);
      })
      .catch((err) => {
        console.error("Failed to load task detail:", err);
        if (!closed) setTaskDetail(null);
      })
      .finally(() => {
        if (!closed) setLoadingDetail(false);
      });

    return () => {
      closed = true;
    };
  }, [projectId, selectedTaskId, taskApi?.getTaskDetail]);

  async function handleForceDispatch(task: TaskTreeNode) {
    const session = sessions.find((s) => s.role === task.owner_role && s.status !== "dismissed");

    setDispatching(true);
    setDispatchError(null);
    setDispatchSuccess(null);

    try {
      if (taskApi) {
        const r = await taskApi.forceDispatch({
          taskId: task.task_id,
          ownerRole: task.owner_role,
          sessionId: session?.sessionId
        });
        if (r.outcome === "dispatched") {
          setDispatchSuccess("Task dispatched successfully");
          reload();
        } else {
          setDispatchError(`Dispatch outcome: ${r.outcome}${r.reason ? ` - ${r.reason}` : ""}`);
        }
      } else {
        const result = await projectApi.dispatch(projectId, {
          session_id: session?.sessionId,
          task_id: task.task_id,
          force: true,
          only_idle: false
        });
        if (result.results && result.results.length > 0) {
          const r = result.results[0];
          if (r.outcome === "dispatched") {
            setDispatchSuccess("Task dispatched successfully");
            reload();
          } else {
            setDispatchError(`Dispatch outcome: ${r.outcome}${r.reason ? ` - ${r.reason}` : ""}`);
          }
        }
      }
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : "Failed to dispatch");
    } finally {
      setDispatching(false);
    }
  }

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

  const taskTree = useMemo(() => {
    const children = new Map<string | null, TaskTreeNode[]>();
    for (const task of visibleTasks) {
      const parent = task.parent_task_id;
      if (parent && parent !== task.task_id && !hiddenTaskIds.has(parent)) {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent)!.push(task);
      }
    }
    const roots = visibleTasks.filter((t) => {
      if (!t.parent_task_id || t.parent_task_id === t.task_id) return true;
      if (hiddenTaskIds.has(t.parent_task_id)) return true;
      return false;
    });
    return { roots, children };
  }, [visibleTasks, hiddenTaskIds]);

  const toggleExpand = (taskId: string) => {
    setExpandedTasks((prev) => {
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
    setExpandedTasks(new Set(visibleTasks.map((t) => t.task_id)));
  };

  const collapseAll = () => {
    setExpandedTasks(new Set());
  };

  const allExpanded = expandedTasks.size === visibleTasks.length && visibleTasks.length > 0;

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.taskTree}</h1>
        </div>
        <div className="empty-state">
          <Loader size={24} className="loading-spinner" />
          <p>{t.loading}</p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section>
        <div className="page-header">
          <h1>{t.taskTree}</h1>
        </div>
        <div className="error-message">{error}</div>
      </section>
    );
  }

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <h1>{t.taskTree}</h1>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn btn-secondary btn-sm" onClick={allExpanded ? collapseAll : expandAll}>
            {allExpanded ? "Collapse All" : "Expand All"}
          </button>
        </div>
      </div>

      <div className="grid grid-2" style={{ alignItems: "stretch", flex: 1, minHeight: 0 }}>
        <div className="card" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div className="card-header" style={{ flexShrink: 0 }}>
            <h3>{t.taskTree}</h3>
            <span className="badge badge-neutral">{visibleTasks.length}</span>
          </div>

          {visibleTasks.length === 0 ? (
            <div className="empty-state" style={{ padding: "24px" }}>
              <p>{t.noData}</p>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                flex: 1,
                overflowY: "auto",
                paddingRight: "4px"
              }}
            >
              {taskTree.roots.map((task) => (
                <TaskNode
                  key={task.task_id}
                  task={task}
                  children={taskTree.children}
                  expanded={expandedTasks}
                  toggleExpand={toggleExpand}
                  selectedTaskId={selectedTaskId}
                  onSelect={setSelectedTaskId}
                  stateLabels={stateLabels}
                  stateColors={stateColors}
                  depth={0}
                />
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {loadingDetail && !taskDetail ? (
            <div className="empty-state" style={{ padding: "32px" }}>
              <Loader size={24} className="loading-spinner" />
              <p>{t.loading}</p>
            </div>
          ) : taskDetail ? (
            <>
              <div className="card-header" style={{ flexShrink: 0 }}>
                <h3>{t.taskDetails}</h3>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setSelectedTaskId(null);
                    setTaskDetail(null);
                  }}
                >
                  <X size={14} />
                </button>
              </div>

              {dispatchError && (
                <div className="error-message" style={{ margin: "0 0 12px 0", flexShrink: 0 }}>
                  {dispatchError}
                </div>
              )}
              {dispatchSuccess && (
                <div className="success-message" style={{ margin: "0 0 12px 0", flexShrink: 0 }}>
                  {dispatchSuccess}
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                  flex: 1,
                  overflowY: "auto",
                  paddingRight: "4px"
                }}
              >
                <div>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.taskTitle}</div>
                  <div style={{ fontWeight: 600, fontSize: "15px" }}>{taskDetail.task.title}</div>
                </div>
                <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.taskState}</div>
                    <span className="badge" style={{ background: stateColors[taskDetail.task.state] }}>
                      {stateLabels[taskDetail.task.state]}
                    </span>
                  </div>
                  <div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.ownerRole}</div>
                    <div>{taskDetail.task.owner_role}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Created By</div>
                    <div>{taskDetail.created_by.role}</div>
                  </div>
                  {!["DONE", "CANCELED", "FAILED"].includes(taskDetail.task.state) && (
                    <div>
                      <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Actions</div>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => {
                          const task = tasks.find((t) => t.task_id === taskDetail.task.task_id);
                          if (task) handleForceDispatch(task);
                        }}
                        disabled={dispatching}
                      >
                        {dispatching ? <Loader size={12} className="loading-spinner" /> : <Play size={12} />}
                        Force Dispatch
                      </button>
                    </div>
                  )}
                </div>

                {taskDetail.task.last_summary && (
                  <div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.taskSummary}</div>
                    <div
                      style={{
                        padding: "8px",
                        background: "var(--bg-elevated)",
                        borderRadius: "6px",
                        fontSize: "13px"
                      }}
                    >
                      {taskDetail.task.last_summary}
                    </div>
                  </div>
                )}

                {taskDetail.create_parameters && Object.keys(taskDetail.create_parameters).length > 0 && (
                  <div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "4px" }}>Content</div>
                    <div
                      style={{
                        padding: "10px 14px",
                        background: "var(--bg-elevated)",
                        borderRadius: "6px",
                        cursor: "pointer",
                        borderLeft: "3px solid var(--accent-primary)"
                      }}
                      onClick={() => setSelectedCreateParams(taskDetail.create_parameters ?? null)}
                    >
                      <div style={{ fontSize: "13px", color: "var(--text-primary)", fontWeight: 500 }}>
                        {(taskDetail.create_parameters.content as string) || "No content"}
                      </div>
                    </div>
                  </div>
                )}

                <div>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "8px" }}>
                    Lifecycle ({taskDetail.stats.lifecycle_event_count} events)
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <LifecycleEventList
                      events={taskDetail.lifecycle}
                      onMinimaxLogClick={(events) => setSelectedMinimaxLogs(events)}
                    />
                  </div>
                </div>

                {taskDetail.task.dependencies.length > 0 && (
                  <div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.dependencies}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                      {taskDetail.task.dependencies.map((dep) => (
                        <span key={dep} className="badge badge-neutral">
                          {dep.slice(0, 16)}...
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {taskDetail.task.write_set.length > 0 && (
                  <div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{t.writeSet}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                      {taskDetail.task.write_set.map((path) => (
                        <code key={path} style={{ fontSize: "11px" }}>
                          {path}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state" style={{ padding: "32px" }}>
              <p>Select a task to view details</p>
            </div>
          )}
        </div>
      </div>
      <TaskDetailsModal
        isOpen={!!selectedMinimaxLogs || !!selectedCreateParams}
        onClose={() => {
          setSelectedMinimaxLogs(null);
          setSelectedCreateParams(null);
        }}
        minimaxLogEvents={selectedMinimaxLogs ?? undefined}
        createParams={selectedCreateParams ?? undefined}
      />
    </section>
  );
}

function LifecycleEventList({
  events,
  onMinimaxLogClick
}: {
  events: TaskLifecycleEvent[];
  onMinimaxLogClick?: (events: TaskLifecycleEvent[]) => void;
}) {
  // 合并逻辑：把所有连续的 MINIMAX_LOG 事件合并成一条，不按时间分割
  // 过滤掉 SYSTEM 类型的事件
  const filteredEvents = events.filter((e) => e.event_type !== "SYSTEM");

  const groupedEvents: (TaskLifecycleEvent | TaskLifecycleEvent[])[] = [];
  let currentMinimaxGroup: TaskLifecycleEvent[] = [];

  filteredEvents.forEach((event) => {
    if (event.event_type === "MINIMAX_LOG") {
      // 连续的 MINIMAX_LOG，合并到一起
      currentMinimaxGroup.push(event);
    } else {
      // 非 MINIMAX_LOG 事件
      if (currentMinimaxGroup.length > 0) {
        // 先保存之前的 MINIMAX_LOG 组
        groupedEvents.push([...currentMinimaxGroup]);
        currentMinimaxGroup = [];
      }
      // 添加当前事件
      groupedEvents.push(event);
    }
  });

  // 添加最后一个 MINIMAX_LOG 组
  if (currentMinimaxGroup.length > 0) {
    groupedEvents.push(currentMinimaxGroup);
  }

  return (
    <>
      {groupedEvents.map((item, idx) => {
        if (Array.isArray(item)) {
          return (
            <MinimaxLogGroup
              key={`minimax-${idx}`}
              events={item}
              onClick={onMinimaxLogClick ? () => onMinimaxLogClick(item) : undefined}
            />
          );
        }
        return <LifecycleEventItem key={idx} event={item} />;
      })}
    </>
  );
}

function LifecycleEventItem({ event }: { event: TaskLifecycleEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasPayload = event.payload && Object.keys(event.payload).length > 0;

  const eventTypeColors: Record<string, string> = {
    TASK_CREATED: "var(--accent-primary)",
    TASK_ASSIGNED: "var(--accent-secondary)",
    TASK_STARTED: "var(--accent-warning)",
    TASK_PROGRESS: "var(--accent-warning)",
    TASK_COMPLETED: "var(--accent-success)",
    TASK_FAILED: "var(--accent-danger)",
    TASK_CANCELED: "var(--text-muted)",
    STATE_CHANGED: "var(--accent-secondary)",
    MINIMAX_LOG: "var(--accent-success)"
  };

  return (
    <div
      style={{
        padding: "8px 12px",
        background: "var(--bg-elevated)",
        borderRadius: "6px",
        borderLeft: `3px solid ${eventTypeColors[event.event_type] || "var(--text-muted)"}`
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: hasPayload ? "pointer" : "default"
        }}
        onClick={() => hasPayload && setExpanded(!expanded)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {hasPayload && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
          <span
            className="badge"
            style={{ background: eventTypeColors[event.event_type] || "var(--text-muted)", fontSize: "10px" }}
          >
            {event.event_type}
          </span>
          <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{event.source}</span>
        </div>
        <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>
          {new Date(event.created_at).toLocaleString()}
        </span>
      </div>
      {expanded && hasPayload && (
        <pre
          style={{
            margin: "8px 0 0",
            padding: "8px",
            background: "var(--bg-surface)",
            borderRadius: "4px",
            fontSize: "10px",
            overflow: "auto",
            maxHeight: "200px"
          }}
        >
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

function MinimaxLogGroup({ events, onClick }: { events: TaskLifecycleEvent[]; onClick?: () => void }) {
  if (events.length === 0) return null;

  const contentByStream: Record<string, string[]> = {};
  events.forEach((e) => {
    const stream = (e.payload?.stream as string) || "other";
    const content = (e.payload?.content as string) || "";
    if (!contentByStream[stream]) contentByStream[stream] = [];
    contentByStream[stream].push(content);
  });

  const firstTime = events[0]?.created_at ? new Date(events[0].created_at).toLocaleString() : "";
  const lastTime = events[events.length - 1]?.created_at
    ? new Date(events[events.length - 1].created_at).toLocaleString()
    : "";

  return (
    <div
      style={{
        padding: "8px 12px",
        background: "var(--bg-elevated)",
        borderRadius: "6px",
        borderLeft: "3px solid var(--accent-success)"
      }}
    >
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
        onClick={() => onClick?.()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <ChevronRight size={12} />
          <span className="badge" style={{ background: "var(--accent-success)", fontSize: "10px" }}>
            MINIMAX_LOG
          </span>
          <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{events.length} logs</span>
        </div>
        <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>
          {firstTime} - {lastTime}
        </span>
      </div>
      {false && (
        <div style={{ margin: "8px 0 0", display: "flex", flexDirection: "column", gap: "8px" }}>
          {Object.entries(contentByStream).map(([stream, contents]) => (
            <div key={stream} style={{ padding: "6px", background: "var(--bg-surface)", borderRadius: "4px" }}>
              <div style={{ fontSize: "10px", color: "var(--text-muted)", marginBottom: "4px" }}>
                {stream.toUpperCase()} ({contents.length} lines)
              </div>
              <pre
                style={{
                  fontSize: "10px",
                  maxHeight: "150px",
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all"
                }}
              >
                {contents.join("\n")}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskNode({
  task,
  children,
  expanded,
  toggleExpand,
  selectedTaskId,
  onSelect,
  stateLabels,
  stateColors,
  depth
}: {
  task: TaskTreeNode;
  children: Map<string | null, TaskTreeNode[]>;
  expanded: Set<string>;
  toggleExpand: (id: string) => void;
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
  stateLabels: Record<TaskState, string>;
  stateColors: Record<TaskState, string>;
  depth: number;
}) {
  const hasChildren = (children.get(task.task_id)?.length ?? 0) > 0;
  const isExpanded = expanded.has(task.task_id);
  const taskChildren = children.get(task.task_id) ?? [];
  const isSelected = selectedTaskId === task.task_id;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 12px",
          background: isSelected ? "var(--accent-primary)20" : "var(--bg-elevated)",
          borderRadius: "6px",
          marginLeft: depth * 16,
          cursor: "pointer",
          border: isSelected ? "1px solid var(--accent-primary)" : "1px solid transparent"
        }}
        onClick={() => onSelect(task.task_id)}
      >
        <div
          onClick={(e) => {
            e.stopPropagation();
            hasChildren && toggleExpand(task.task_id);
          }}
        >
          {hasChildren ? (
            isExpanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            <Circle size={6} style={{ marginLeft: "4px", marginRight: "4px" }} />
          )}
        </div>
        <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: stateColors[task.state] }} />
        <span style={{ fontWeight: 500, fontSize: "13px", flex: 1 }}>{task.title}</span>
        <span className="badge badge-neutral" style={{ fontSize: "10px" }}>
          {stateLabels[task.state]}
        </span>
      </div>
      {isExpanded &&
        taskChildren.map((child) => (
          <TaskNode
            key={child.task_id}
            task={child}
            children={children}
            expanded={expanded}
            toggleExpand={toggleExpand}
            selectedTaskId={selectedTaskId}
            onSelect={onSelect}
            stateLabels={stateLabels}
            stateColors={stateColors}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}
