import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Edit, Play, RefreshCw, Square } from "lucide-react";
import { workflowApi } from "@/services/api";
import { useWorkflowOrchestratorStatus, useWorkflowRunStatus } from "@/hooks/useWorkflowData";
import { AgentChatView } from "./AgentChatView";
import { ChatTimelineView } from "./ChatTimelineView";
import { TaskTreeView } from "./TaskTreeView";
import type {
  AgentIOTimelineItem,
  SessionRecord,
  TaskTreeNode,
  WorkflowRunRecord,
  WorkflowRunState,
  WorkflowSessionRecord,
  WorkflowTaskState,
  WorkflowTaskTreeRuntimeResponse,
  WorkflowRunWorkspaceView as WorkflowRunWorkspaceTab
} from "@/types";

interface WorkflowRunWorkspaceViewProps {
  runId: string;
  view: WorkflowRunWorkspaceTab;
}

const TERMINAL_TASK_STATES = new Set<WorkflowTaskState>(["DONE", "CANCELED"]);

function getEffectiveRunStatus(run: WorkflowRunRecord | null, runtimeStatus?: WorkflowRunState): WorkflowRunState {
  const raw = runtimeStatus ?? run?.status ?? "created";
  if (raw !== "stopped" && raw !== "running") {
    return raw;
  }
  const tasks = run?.runtime?.tasks ?? [];
  if (tasks.length === 0) {
    return raw;
  }
  const allTerminal = tasks.every((task) => TERMINAL_TASK_STATES.has(task.state));
  return allTerminal ? "finished" : raw;
}

function renderMatrix(title: string, matrix?: Record<string, string[]>) {
  const rows = Object.entries(matrix ?? {});
  return (
    <div className="card" style={{ marginBottom: "12px" }}>
      <div className="card-header">
        <h3>{title}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="empty-state" style={{ padding: "12px" }}>
          <p>No data</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([from, to]) => (
                <tr key={`${title}-${from}`}>
                  <td>
                    <code>{from}</code>
                  </td>
                  <td>{to.length > 0 ? to.join(", ") : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function WorkflowRunWorkspaceView({ runId, view }: WorkflowRunWorkspaceViewProps) {
  const [run, setRun] = useState<WorkflowRunRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<"start" | "stop" | null>(null);

  const [treeRuntime, setTreeRuntime] = useState<WorkflowTaskTreeRuntimeResponse | null>(null);
  const [treeRuntimeError, setTreeRuntimeError] = useState<string | null>(null);
  const [treeRuntimeLoading, setTreeRuntimeLoading] = useState(false);

  const [sessions, setSessions] = useState<WorkflowSessionRecord[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  const [timeline, setTimeline] = useState<AgentIOTimelineItem[]>([]);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const [orchestratorSettings, setOrchestratorSettings] = useState<{
    auto_dispatch_enabled: boolean;
    auto_dispatch_remaining: number;
    hold_enabled: boolean;
    reminder_mode: "backoff" | "fixed_interval";
    updated_at: string;
  } | null>(null);

  const [template, setTemplate] = useState<{
    templateId: string;
    routeTable?: Record<string, string[]>;
    taskAssignRouteTable?: Record<string, string[]>;
    routeDiscussRounds?: Record<string, Record<string, number>>;
  } | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);

  const { status, error: statusError, reload: reloadStatus } = useWorkflowRunStatus(runId);
  const {
    status: orchestratorStatus,
    error: orchestratorError,
    reload: reloadOrchestrator
  } = useWorkflowOrchestratorStatus(8000);

  const loadRun = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await workflowApi.getRun(runId);
      setRun(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow run");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  const loadTaskTreeRuntime = useCallback(
    async (withLoading = false) => {
      if (withLoading) {
        setTreeRuntimeLoading(true);
      }
      try {
        const payload = await workflowApi.getTaskTreeRuntime(runId);
        setTreeRuntime(payload);
        setTreeRuntimeError(null);
      } catch (err) {
        setTreeRuntimeError(err instanceof Error ? err.message : "Failed to load workflow task runtime");
      } finally {
        if (withLoading) {
          setTreeRuntimeLoading(false);
        }
      }
    },
    [runId]
  );

  const loadSessions = useCallback(
    async (withLoading = false) => {
      if (withLoading) {
        setSessionsLoading(true);
      }
      try {
        const payload = await workflowApi.getSessions(runId);
        setSessions(payload.items ?? []);
        setSessionsError(null);
      } catch (err) {
        setSessionsError(err instanceof Error ? err.message : "Failed to load workflow sessions");
      } finally {
        if (withLoading) {
          setSessionsLoading(false);
        }
      }
    },
    [runId]
  );

  const loadTimeline = useCallback(
    async (withLoading = false) => {
      if (withLoading) {
        setTimelineLoading(true);
      }
      try {
        const payload = await workflowApi.getTimeline(runId, 400);
        setTimeline(payload.items ?? []);
        setTimelineError(null);
      } catch (err) {
        setTimelineError(err instanceof Error ? err.message : "Failed to load workflow timeline");
      } finally {
        if (withLoading) {
          setTimelineLoading(false);
        }
      }
    },
    [runId]
  );

  const loadOrchestratorSettings = useCallback(async () => {
    try {
      const payload = await workflowApi.getOrchestratorSettings(runId);
      setOrchestratorSettings(payload);
    } catch {
      setOrchestratorSettings(null);
    }
  }, [runId]);

  useEffect(() => {
    void loadRun();
  }, [loadRun]);

  useEffect(() => {
    if (view === "task-tree") {
      void loadTaskTreeRuntime(true);
    }
    if (view === "chat") {
      void Promise.all([loadTimeline(true), loadSessions(true)]);
    }
    if (view === "agent-chat") {
      void loadSessions(true);
    }
  }, [view, loadTaskTreeRuntime, loadTimeline, loadSessions]);

  useEffect(() => {
    if (view !== "task-tree") {
      return;
    }
    if (run?.status !== "running") {
      return;
    }
    const timer = setInterval(() => {
      void loadTaskTreeRuntime(false);
    }, 5000);
    return () => clearInterval(timer);
  }, [view, run?.status, loadTaskTreeRuntime]);

  useEffect(() => {
    if (view !== "chat" && view !== "agent-chat") {
      return;
    }
    if (run?.status !== "running") {
      return;
    }
    const timer = setInterval(() => {
      if (view === "chat") {
        void loadTimeline(false);
      }
      void loadSessions(false);
    }, 5000);
    return () => clearInterval(timer);
  }, [view, run?.status, loadTimeline, loadSessions]);

  useEffect(() => {
    if (status?.status) {
      setRun((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          status: status.status,
          startedAt: status.startedAt ?? prev.startedAt,
          stoppedAt: status.stoppedAt ?? prev.stoppedAt,
          lastHeartbeatAt: status.lastHeartbeatAt ?? prev.lastHeartbeatAt
        };
      });
    }
  }, [status]);

  useEffect(() => {
    const templateId = run?.templateId;
    if (!templateId) {
      setTemplate(null);
      return;
    }
    const templateIdValue: string = templateId;
    let closed = false;
    async function loadTemplateSnapshot() {
      setTemplateLoading(true);
      try {
        const payload = await workflowApi.getTemplate(templateIdValue);
        if (closed) {
          return;
        }
        setTemplate({
          templateId: payload.templateId,
          routeTable: payload.routeTable,
          taskAssignRouteTable: payload.taskAssignRouteTable,
          routeDiscussRounds: payload.routeDiscussRounds
        });
        setTemplateError(null);
      } catch (err) {
        if (!closed) {
          setTemplate(null);
          setTemplateError(err instanceof Error ? err.message : "Failed to load template snapshot");
        }
      } finally {
        if (!closed) {
          setTemplateLoading(false);
        }
      }
    }
    void loadTemplateSnapshot();
    return () => {
      closed = true;
    };
  }, [run?.templateId]);

  useEffect(() => {
    void loadOrchestratorSettings();
  }, [loadOrchestratorSettings]);

  const onStartStop = async (action: "start" | "stop") => {
    setWorking(action);
    try {
      if (action === "start") {
        await workflowApi.startRun(runId);
      } else {
        await workflowApi.stopRun(runId);
      }
      await Promise.all([
        loadRun(),
        reloadStatus(),
        reloadOrchestrator(),
        loadTaskTreeRuntime(false),
        loadTimeline(false),
        loadSessions(false),
        loadOrchestratorSettings()
      ]);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : `Failed to ${action} workflow run`);
    } finally {
      setWorking(null);
    }
  };

  const taskTreeNodes = useMemo((): TaskTreeNode[] => {
    return (treeRuntime?.nodes ?? []).map((node) => ({
      task_id: node.taskId,
      task_detail_id: node.taskId,
      task_kind: "EXECUTION",
      parent_task_id: node.parentTaskId ?? "",
      root_task_id: (treeRuntime?.roots?.[0] as string | undefined) ?? node.taskId,
      title: node.resolvedTitle,
      state: node.runtime?.state ?? "PLANNED",
      creator_role: node.creatorRole ?? null,
      creator_session_id: node.creatorSessionId ?? null,
      owner_role: node.ownerRole,
      owner_session: null,
      priority: 0,
      dependencies: node.dependencies ?? [],
      write_set: node.writeSet ?? [],
      acceptance: node.acceptance ?? [],
      artifacts: node.artifacts ?? [],
      alert: null,
      granted_at: null,
      closed_at: null,
      close_report_id: null,
      created_at: run?.createdAt ?? new Date().toISOString(),
      updated_at: node.runtime?.lastTransitionAt ?? run?.updatedAt ?? new Date().toISOString(),
      last_summary: node.runtime?.lastSummary ?? null
    }));
  }, [treeRuntime, run?.createdAt, run?.updatedAt]);

  const workflowTaskApi = useMemo(() => {
    return {
      getTaskDetail: async (taskId: string) => workflowApi.getTaskDetail(runId, taskId),
      forceDispatch: async ({ taskId }: { taskId: string; ownerRole: string; sessionId?: string }) => {
        const result = await workflowApi.dispatch(runId, {
          task_id: taskId,
          force: true,
          only_idle: false
        });
        return (
          result.results?.[0] ?? {
            outcome: "no_task" as const
          }
        );
      }
    };
  }, [runId]);

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>Running Workflow</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>Loading workflow run...</p>
        </div>
      </section>
    );
  }

  if (error || !run) {
    return (
      <section>
        <div className="page-header">
          <h1>Running Workflow</h1>
          <a className="btn btn-secondary" href="#/workflow">
            <ArrowLeft size={14} /> Back to Runs
          </a>
        </div>
        <div className="error-message">{error ?? "Workflow run not found"}</div>
      </section>
    );
  }

  const effectiveStatus = getEffectiveRunStatus(run, status?.status);
  const canStart = effectiveStatus === "created" || effectiveStatus === "stopped";
  const canStop = effectiveStatus === "running";

  return (
    <section>
      <div className="page-header">
        <h1>Running Workflow: {run.runId}</h1>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            className="btn btn-secondary"
            onClick={() =>
              void Promise.all([
                loadRun(),
                reloadStatus(),
                reloadOrchestrator(),
                loadTaskTreeRuntime(false),
                loadTimeline(false),
                loadSessions(false),
                loadOrchestratorSettings()
              ])
            }
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <a className="btn btn-secondary" href="#/workflow">
            <ArrowLeft size={14} /> Back to Runs
          </a>
        </div>
      </div>

      {(statusError || orchestratorError) && <div className="error-message">{statusError ?? orchestratorError}</div>}

      {view === "overview" && (
        <>
          <div className="card">
            <div className="card-header">
              <h3>Runtime</h3>
              <div style={{ display: "flex", gap: "8px" }}>
                {canStart && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void onStartStop("start")}
                    disabled={working !== null}
                  >
                    <Play size={14} /> Start
                  </button>
                )}
                {canStop && (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => void onStartStop("stop")}
                    disabled={working !== null}
                  >
                    <Square size={14} /> Stop
                  </button>
                )}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
              <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Status</div>
                <div style={{ fontWeight: 600 }}>{effectiveStatus}</div>
              </div>
              <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Workspace</div>
                <div style={{ fontWeight: 600, wordBreak: "break-all" }}>{run.workspacePath}</div>
              </div>
              <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Started At</div>
                <div style={{ fontWeight: 600 }}>{status?.startedAt ?? run.startedAt ?? "-"}</div>
              </div>
              <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Stopped At</div>
                <div style={{ fontWeight: 600 }}>{status?.stoppedAt ?? run.stoppedAt ?? "-"}</div>
              </div>
              <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Auto Dispatch Enabled</div>
                <div style={{ fontWeight: 600 }}>{orchestratorSettings?.auto_dispatch_enabled ? "Yes" : "No"}</div>
              </div>
              <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Dispatch Budget</div>
                <div style={{ fontWeight: 600 }}>{orchestratorSettings?.auto_dispatch_remaining ?? 0}</div>
              </div>
              <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Hold Enabled</div>
                <div style={{ fontWeight: 600 }}>{orchestratorSettings?.hold_enabled ? "Yes" : "No"}</div>
              </div>
              <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Reminder Mode</div>
                <div style={{ fontWeight: 600 }}>{orchestratorSettings?.reminder_mode ?? "backoff"}</div>
              </div>
              <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Orchestrator Active Runs</div>
                <div style={{ fontWeight: 600 }}>{orchestratorStatus?.activeRunCount ?? 0}</div>
              </div>
            </div>
          </div>
        </>
      )}

      {view === "task-tree" && (
        <TaskTreeView
          projectId={runId}
          project={null}
          sessions={sessions as unknown as SessionRecord[]}
          tasks={taskTreeNodes}
          locks={[]}
          events={[]}
          timeline={[]}
          loading={treeRuntimeLoading}
          error={treeRuntimeError}
          reload={() => void loadTaskTreeRuntime(false)}
          taskApi={workflowTaskApi}
        />
      )}

      {view === "chat" && (
        <div style={{ height: "calc(100vh - 220px)", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {timelineError && <div className="error-message">{timelineError}</div>}
          {sessionsError && <div className="error-message">{sessionsError}</div>}
          {timelineLoading ? (
            <div className="card">
              <div className="empty-state" style={{ padding: "24px" }}>
                <p>Loading chat timeline...</p>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0 }}>
              <ChatTimelineView timeline={timeline} />
            </div>
          )}
        </div>
      )}

      {view === "agent-chat" && (
        <div>
          {sessionsError && <div className="error-message">{sessionsError}</div>}
          {sessionsLoading ? (
            <div className="card">
              <div className="empty-state" style={{ padding: "24px" }}>
                <p>Loading run sessions...</p>
              </div>
            </div>
          ) : (
            <AgentChatView runId={runId} sessions={sessions} />
          )}
        </div>
      )}

      {view === "team-config" && (
        <div style={{ height: "calc(100vh - 220px)", minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", marginBottom: "12px" }}>
            <a className="btn btn-secondary btn-sm" href={`#/workflow/templates/${run.templateId}/edit`}>
              <Edit size={14} /> Edit Template
            </a>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingRight: "4px" }}>
            {templateLoading && (
              <div className="card">
                <div className="empty-state" style={{ padding: "24px" }}>
                  <p>Loading template snapshot...</p>
                </div>
              </div>
            )}
            {templateError && <div className="error-message">{templateError}</div>}

            {!templateLoading && !templateError && template && (
              <>
                {renderMatrix("Message Route Matrix", template.routeTable)}
                {renderMatrix("Task Assign Matrix", template.taskAssignRouteTable)}
                <div className="card">
                  <div className="card-header">
                    <h3>Discuss Rounds</h3>
                  </div>
                  {Object.keys(template.routeDiscussRounds ?? {}).length === 0 ? (
                    <div className="empty-state" style={{ padding: "12px" }}>
                      <p>No discuss round overrides</p>
                    </div>
                  ) : (
                    <div className="table-container">
                      <table>
                        <thead>
                          <tr>
                            <th>From</th>
                            <th>To</th>
                            <th>Rounds</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(template.routeDiscussRounds ?? {}).flatMap(([from, map]) =>
                            Object.entries(map).map(([to, rounds]) => (
                              <tr key={`round-${from}-${to}`}>
                                <td>
                                  <code>{from}</code>
                                </td>
                                <td>
                                  <code>{to}</code>
                                </td>
                                <td>{rounds}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
