import { useState } from "react";
import { Play, Square, RefreshCw, Eye, Plus } from "lucide-react";
import { workflowApi } from "@/services/api";
import { useWorkflowOrchestratorStatus, useWorkflowRuns } from "@/hooks/useWorkflowData";
import type { WorkflowRunRecord, WorkflowRunState } from "@/types";

const TERMINAL_TASK_STATES = new Set(["DONE", "CANCELED"]);

function getEffectiveRunStatus(run: WorkflowRunRecord): WorkflowRunState {
  const raw = run.status;
  if (raw !== "stopped" && raw !== "running") {
    return raw;
  }
  const tasks = run.runtime?.tasks ?? [];
  if (tasks.length === 0) {
    return raw;
  }
  const allTerminal = tasks.every((task) => TERMINAL_TASK_STATES.has(task.state));
  return allTerminal ? "finished" : raw;
}

export function WorkflowRunsView() {
  const { items, loading, error, reload } = useWorkflowRuns();
  const {
    status: orchestratorStatus,
    error: orchestratorError,
    reload: reloadOrchestrator
  } = useWorkflowOrchestratorStatus(8000);
  const [workingRunId, setWorkingRunId] = useState<string | null>(null);

  const handleStartStop = async (run: WorkflowRunRecord, action: "start" | "stop") => {
    setWorkingRunId(run.runId);
    try {
      if (action === "start") {
        await workflowApi.startRun(run.runId);
      } else {
        await workflowApi.stopRun(run.runId);
      }
      await Promise.all([reload(), reloadOrchestrator()]);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : `Failed to ${action} run`);
    } finally {
      setWorkingRunId(null);
    }
  };

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>Running Workflow</h1>
        </div>
        <div className="empty-state">
          <div className="loading-spinner" style={{ margin: "0 auto" }} />
          <p style={{ marginTop: "16px" }}>Loading workflow runs...</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>Running Workflow</h1>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn btn-secondary" onClick={() => Promise.all([reload(), reloadOrchestrator()])}>
            <RefreshCw size={14} /> Refresh
          </button>
          <a className="btn btn-primary" href="#/workflow/runs/new">
            <Plus size={14} /> Create Run
          </a>
        </div>
      </div>

      {(error || orchestratorError) && <div className="error-message">{error ?? orchestratorError}</div>}

      <div className="card">
        <div className="card-header">
          <h3>Workflow Orchestrator</h3>
        </div>
        {orchestratorStatus ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
            <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
              <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Started</div>
              <div style={{ fontWeight: 600 }}>{orchestratorStatus.started ? "Yes" : "No"}</div>
            </div>
            <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
              <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Active Run Count</div>
              <div style={{ fontWeight: 600 }}>{orchestratorStatus.activeRunCount}</div>
            </div>
            <div style={{ padding: "12px", borderRadius: "8px", background: "var(--bg-surface)" }}>
              <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Active Run IDs</div>
              <div style={{ fontWeight: 600, whiteSpace: "normal" }}>
                {orchestratorStatus.activeRunIds.length > 0 ? orchestratorStatus.activeRunIds.join(", ") : "-"}
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-state" style={{ padding: "16px" }}>
            <p>No orchestrator status available.</p>
          </div>
        )}
      </div>

      <div className="card">
        {items.length === 0 ? (
          <div className="empty-state" style={{ padding: "32px 12px" }}>
            <p>No workflow runs yet.</p>
            <a className="btn btn-primary" href="#/workflow/runs/new">
              Create your first run
            </a>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Run ID</th>
                  <th>Run Name</th>
                  <th>Template</th>
                  <th>Status</th>
                  <th>Workspace</th>
                  <th>Started</th>
                  <th>Stopped</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((run) => {
                  const effectiveStatus = getEffectiveRunStatus(run);
                  const canStart = effectiveStatus === "created" || effectiveStatus === "stopped";
                  const canStop = effectiveStatus === "running";
                  return (
                    <tr key={run.runId}>
                      <td>
                        <a className="run-link" href={`#/workflow/runs/${run.runId}/overview`}>
                          <code>{run.runId}</code>
                        </a>
                      </td>
                      <td>
                        <a
                          className="run-link"
                          href={`#/workflow/runs/${run.runId}/overview`}
                          style={{ fontWeight: 600 }}
                        >
                          {run.name || run.runId}
                        </a>
                      </td>
                      <td>
                        <code>{run.templateId}</code>
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            effectiveStatus === "running"
                              ? "badge-success"
                              : effectiveStatus === "failed"
                                ? "badge-danger"
                                : effectiveStatus === "finished"
                                  ? "badge-success"
                                  : effectiveStatus === "stopped"
                                    ? "badge-warning"
                                    : "badge-neutral"
                          }`}
                        >
                          {effectiveStatus}
                        </span>
                      </td>
                      <td
                        style={{ maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis" }}
                        title={run.workspacePath}
                      >
                        {run.workspacePath}
                      </td>
                      <td>{run.startedAt ?? "-"}</td>
                      <td>{run.stoppedAt ?? "-"}</td>
                      <td>
                        <div style={{ display: "flex", gap: "8px" }}>
                          {canStart && (
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => handleStartStop(run, "start")}
                              disabled={workingRunId === run.runId}
                            >
                              <Play size={14} /> Start
                            </button>
                          )}
                          {canStop && (
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={() => handleStartStop(run, "stop")}
                              disabled={workingRunId === run.runId}
                            >
                              <Square size={14} /> Stop
                            </button>
                          )}
                          <a className="btn btn-secondary btn-sm" href={`#/workflow/runs/${run.runId}/overview`}>
                            <Eye size={14} /> View
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
