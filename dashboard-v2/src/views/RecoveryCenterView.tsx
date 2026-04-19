import { useMemo, useState } from "react";
import type { RuntimeRecoveryResponse } from "@/types";

interface RecoveryCenterViewProps {
  title: string;
  loading: boolean;
  error: string | null;
  response: RuntimeRecoveryResponse | null;
  onReload: () => void;
  onDismiss: (sessionId: string) => Promise<void>;
  onRepair: (sessionId: string, target: "idle" | "blocked") => Promise<void>;
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatConfirmationMessage(title: string, risk: string | null): string {
  return [title, risk].filter(Boolean).join("\n\n");
}

export function RecoveryCenterView({
  title,
  loading,
  error,
  response,
  onReload,
  onDismiss,
  onRepair
}: RecoveryCenterViewProps) {
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const items = response?.items ?? [];
  const summary = response?.summary;
  const selected = useMemo(
    () => items.find((item) => item.session_id === selectedSessionId) ?? items[0] ?? null,
    [items, selectedSessionId]
  );

  async function runAction(action: () => Promise<void>, key: string) {
    try {
      setBusyAction(key);
      setActionError(null);
      await action();
      onReload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Recovery action failed");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section>
      <div className="page-header">
        <h1>{title}</h1>
        <button className="btn btn-secondary" onClick={onReload}>
          Reload
        </button>
      </div>

      {error && <div className="error-message">{error}</div>}
      {actionError && <div className="error-message">{actionError}</div>}

      {summary && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: "12px",
            marginBottom: "16px"
          }}
        >
          {[
            ["All Sessions", summary.all_sessions_total],
            ["Recovery Candidates", summary.recovery_candidates_total],
            ["Running Candidates", summary.running],
            ["Blocked", summary.blocked],
            ["Cooling Down", summary.cooling_down],
            ["Failed Recently", summary.failed_recently],
            ["Dismissed", summary.dismissed]
          ].map(([label, value]) => (
            <div key={String(label)} className="card" style={{ padding: "12px" }}>
              <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{label}</div>
              <div style={{ fontSize: "20px", fontWeight: 700 }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="card">
          <div className="empty-state" style={{ padding: "24px" }}>
            <div className="loading-spinner" style={{ margin: "0 auto" }} />
            <p style={{ marginTop: "16px" }}>Loading recovery incidents...</p>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(320px, 1fr)", gap: "16px" }}>
          <div className="card">
            <div className="card-header">
              <h3>Incidents</h3>
            </div>
            {items.length === 0 ? (
              <div className="empty-state" style={{ padding: "24px" }}>
                <p>No recovery incidents in this scope.</p>
              </div>
            ) : (
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Task</th>
                      <th>Failure</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr
                        key={item.session_id}
                        onClick={() => setSelectedSessionId(item.session_id)}
                        style={{
                          cursor: "pointer",
                          background: selected?.session_id === item.session_id ? "var(--bg-elevated)" : undefined
                        }}
                      >
                        <td>
                          <strong>{item.role}</strong>
                          <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{item.session_id}</div>
                        </td>
                        <td>{item.status}</td>
                        <td>{item.current_task_id ?? "-"}</td>
                        <td>{item.code ?? item.last_failure_kind ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <h3>Session Detail</h3>
            </div>
            {!selected ? (
              <div className="empty-state" style={{ padding: "24px" }}>
                <p>Select a recovery row to inspect details.</p>
              </div>
            ) : (
              <div style={{ display: "grid", gap: "10px" }}>
                {[
                  ["Role", selected.role],
                  ["Status", selected.status],
                  ["Provider", selected.provider],
                  ["Provider Session", selected.provider_session_id ?? "-"],
                  ["Current Task", selected.current_task_id ?? "-"],
                  ["Task Title", selected.current_task_title ?? "-"],
                  ["Task State", selected.current_task_state ?? "-"],
                  ["Cooldown Until", formatDateTime(selected.cooldown_until)],
                  ["Last Failure", formatDateTime(selected.last_failure_at)],
                  ["Failure Kind", selected.last_failure_kind ?? "-"],
                  ["Code", selected.code ?? "-"],
                  ["Retryable", selected.retryable === null ? "-" : selected.retryable ? "yes" : "no"],
                  ["Raw Status", selected.raw_status ?? "-"],
                  ["Last Event", selected.last_event_type ?? "-"],
                  ["Retry Dispatch", selected.can_retry_dispatch ? "yes" : "no"],
                  ["Requires Confirmation", selected.requires_confirmation ? "yes" : "no"],
                  ["Error Streak", selected.error_streak],
                  ["Timeout Streak", selected.timeout_streak]
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{label}</div>
                    <div>{String(value)}</div>
                  </div>
                ))}
                <div>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Message</div>
                  <div>{selected.message ?? "-"}</div>
                </div>
                <div>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Next Action</div>
                  <div>{selected.next_action ?? "-"}</div>
                </div>
                <div>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Disabled Reason</div>
                  <div>{selected.disabled_reason ?? "-"}</div>
                </div>
                <div>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Risk</div>
                  <div>{selected.risk ?? "-"}</div>
                </div>
                <div>
                  <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Latest Recovery Events</div>
                  {selected.latest_events.length === 0 ? (
                    <div>-</div>
                  ) : (
                    <div style={{ display: "grid", gap: "8px" }}>
                      {selected.latest_events.map((event) => (
                        <div
                          key={`${event.event_type}:${event.created_at}`}
                          className="card"
                          style={{ padding: "10px" }}
                        >
                          <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                            {event.event_type} · {formatDateTime(event.created_at)}
                          </div>
                          <div>{event.payload_summary}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" }}>
                  <button
                    className="btn btn-secondary"
                    disabled={!selected.can_dismiss || busyAction === `dismiss:${selected.session_id}`}
                    onClick={() =>
                      void runAction(() => onDismiss(selected.session_id), `dismiss:${selected.session_id}`)
                    }
                  >
                    Dismiss
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={!selected.can_repair_to_idle || busyAction === `idle:${selected.session_id}`}
                    onClick={() => {
                      if (
                        selected.requires_confirmation &&
                        !window.confirm(
                          formatConfirmationMessage("Manual recovery to idle requires confirmation.", selected.risk)
                        )
                      ) {
                        return;
                      }
                      void runAction(() => onRepair(selected.session_id, "idle"), `idle:${selected.session_id}`);
                    }}
                  >
                    Repair to Idle
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={!selected.can_repair_to_blocked || busyAction === `blocked:${selected.session_id}`}
                    onClick={() =>
                      void runAction(() => onRepair(selected.session_id, "blocked"), `blocked:${selected.session_id}`)
                    }
                  >
                    Repair to Blocked
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
