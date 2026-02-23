import { useMemo, useState } from "react";
import { useTranslation } from "@/hooks/i18n";
import type { ProjectDetail, SessionRecord, TaskTreeNode, LockRecord, EventRecord, AgentIOTimelineItem } from "@/types";
import { projectApi } from "@/services/api";
import { XCircle } from "lucide-react";

interface SessionManagerViewProps {
  projectId: string;
  project: ProjectDetail | null;
  sessions: SessionRecord[];
  tasks: TaskTreeNode[];
  locks: LockRecord[];
  events: EventRecord[];
  timeline: AgentIOTimelineItem[];
  reload: () => void;
}

export function SessionManagerView({ projectId, sessions, reload }: SessionManagerViewProps) {
  const t = useTranslation();
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const filteredSessions = useMemo(() => {
    return sessions
      .filter((s) => statusFilter === "all" || s.status === statusFilter)
      .filter((s) => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        const sessionId = s.sessionId?.toLowerCase() || "";
        const role = s.role?.toLowerCase() || "";
        return sessionId.includes(q) || role.includes(q);
      });
  }, [sessions, statusFilter, searchQuery]);

  const selectedSession = sessions.find((s) => s.sessionId === selectedSessionId);

  async function handleDismiss(sessionId: string) {
    try {
      setBusyAction(sessionId);
      setActionError(null);
      await projectApi.dismissSession(projectId, sessionId);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Dismiss failed");
    } finally {
      setBusyAction(null);
    }
  }

  const statusColors: Record<string, string> = {
    running: "var(--accent-success)",
    idle: "var(--text-muted)",
    blocked: "var(--accent-warning)",
    dismissed: "var(--accent-danger)",
  };

  return (
    <section>
      <div className="page-header">
        <h1>{t.sessionManager}</h1>
      </div>

      {actionError && <div className="error-message">{actionError}</div>}

      <div className="card">
        <div className="card-header">
          <h3>{t.sessions}</h3>
          <span className="badge badge-neutral">{filteredSessions.length}</span>
        </div>

        <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.search}
            style={{ flex: 1 }}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="running">Running</option>
            <option value="idle">Idle</option>
            <option value="blocked">Blocked</option>
            <option value="dismissed">Dismissed</option>
          </select>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "400px", overflow: "auto" }}>
          {filteredSessions.map((session) => {
            const safeStatus = session.status || "unknown";
            return (
              <div 
                key={session.sessionId}
                style={{ 
                  padding: "12px", 
                  background: selectedSessionId === session.sessionId ? "var(--accent-primary)20" : "var(--bg-elevated)", 
                  borderRadius: "8px",
                  cursor: "pointer",
                  border: `1px solid ${selectedSessionId === session.sessionId ? "var(--accent-primary)" : "transparent"}`
                }}
                onClick={() => setSelectedSessionId(session.sessionId)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 500 }}>{session.role}</div>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                      {session.sessionId.slice(0, 30)}...
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                    <span 
                      className="badge" 
                      style={{ background: statusColors[safeStatus] || "var(--text-muted)" }}
                    >
                      {safeStatus}
                    </span>
                    {safeStatus !== "dismissed" && (
                      <button 
                        className="btn btn-danger btn-sm"
                        onClick={(e) => { e.stopPropagation(); handleDismiss(session.sessionId); }}
                        disabled={busyAction === session.sessionId}
                      >
                        <XCircle size={12} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selectedSession && (
        <div className="card">
          <div className="card-header">
            <h3>Session Details</h3>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div><strong>Session ID:</strong> <code>{selectedSession.sessionId}</code></div>
            <div><strong>Role:</strong> {selectedSession.role}</div>
            <div><strong>Status:</strong> {selectedSession.status}</div>
            <div><strong>Provider:</strong> {selectedSession.provider || "-"}</div>
            <div><strong>Provider Session ID:</strong> {selectedSession.providerSessionId ? <code>{selectedSession.providerSessionId}</code> : "-"}</div>
            <div><strong>Agent Tool:</strong> {selectedSession.agentTool || "-"}</div>
            <div><strong>Session Key:</strong> {selectedSession.sessionKey ? <code>{selectedSession.sessionKey}</code> : "-"}</div>
            <div><strong>Locks Held:</strong> {selectedSession.locksHeldCount ?? 0}</div>
            <div><strong>Created:</strong> {selectedSession.createdAt ? new Date(selectedSession.createdAt).toLocaleString() : "N/A"}</div>
            <div><strong>Last Updated:</strong> {selectedSession.updatedAt ? new Date(selectedSession.updatedAt).toLocaleString() : "N/A"}</div>
            <div><strong>Last Active:</strong> {selectedSession.lastActiveAt ? new Date(selectedSession.lastActiveAt).toLocaleString() : "N/A"}</div>
            <div><strong>Last Dispatched:</strong> {selectedSession.lastDispatchedAt ? new Date(selectedSession.lastDispatchedAt).toLocaleString() : "N/A"}</div>
            {selectedSession.currentTaskId && (
              <div><strong>Current Task:</strong> <code>{selectedSession.currentTaskId}</code></div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
