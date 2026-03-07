import { useState, useMemo } from "react";
import { useTranslation } from "@/hooks/i18n";
import type { ProjectDetail, SessionRecord, TaskTreeNode, LockRecord, EventRecord, AgentIOTimelineItem } from "@/types";
import { projectApi } from "@/services/api";
import { Lock, Unlock, Loader } from "lucide-react";

interface LockManagerViewProps {
  projectId: string;
  project: ProjectDetail | null;
  sessions: SessionRecord[];
  tasks: TaskTreeNode[];
  locks: LockRecord[];
  events: EventRecord[];
  timeline: AgentIOTimelineItem[];
  reload: () => void;
}

export function LockManagerView({ projectId, locks, reload }: LockManagerViewProps) {
  const t = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "released" | "expired">("all");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredLocks = useMemo(() => {
    return locks
      .filter((l) => statusFilter === "all" || l.status === statusFilter)
      .filter((l) => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return l.lockKey.toLowerCase().includes(q) || l.ownerSessionId.toLowerCase().includes(q);
      });
  }, [locks, statusFilter, searchQuery]);

  async function handleRelease(lock: LockRecord) {
    try {
      setBusyAction(lock.lockId);
      setError(null);
      await projectApi.releaseLock(projectId, {
        session_id: lock.ownerSessionId,
        lock_key: lock.lockKey
      });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to release lock");
    } finally {
      setBusyAction(null);
    }
  }

  const statusColors: Record<string, string> = {
    active: "var(--accent-success)",
    released: "var(--text-muted)",
    expired: "var(--accent-warning)"
  };

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <h1>{t.lockManager}</h1>
      </div>

      {error && (
        <div className="error-message" style={{ flexShrink: 0 }}>
          {error}
        </div>
      )}

      <div
        className="card"
        style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        <div className="card-header" style={{ flexShrink: 0 }}>
          <h3>{t.lockManager}</h3>
          <span className="badge badge-neutral">{filteredLocks.length}</span>
        </div>

        <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexShrink: 0, padding: "0 16px" }}>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.search}
            style={{ flex: 1 }}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="released">Released</option>
            <option value="expired">Expired</option>
          </select>
        </div>

        <div className="table-container" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 16px" }}>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Key</th>
                <th>Owner</th>
                <th>Type</th>
                <th>Purpose</th>
                <th>Expires</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredLocks.map((lock) => (
                <tr key={lock.lockId}>
                  <td>
                    <span className="badge" style={{ background: statusColors[lock.status] || "var(--text-muted)" }}>
                      {lock.status}
                    </span>
                  </td>
                  <td>
                    <code style={{ fontSize: "11px" }}>{lock.lockKey}</code>
                  </td>
                  <td>
                    <span className="badge badge-neutral">{lock.ownerSessionId.slice(0, 16)}...</span>
                  </td>
                  <td>{lock.targetType ?? "unknown"}</td>
                  <td>{lock.purpose ?? "-"}</td>
                  <td style={{ fontSize: "12px" }}>{new Date(lock.expiresAt).toLocaleString()}</td>
                  <td>
                    {lock.status === "active" && (
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => handleRelease(lock)}
                        disabled={busyAction === lock.lockId}
                      >
                        {busyAction === lock.lockId ? (
                          <Loader size={12} className="loading-spinner" />
                        ) : (
                          <Unlock size={12} />
                        )}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filteredLocks.length === 0 && (
          <div className="empty-state" style={{ padding: "24px", flexShrink: 0 }}>
            <Lock size={32} style={{ opacity: 0.3 }} />
            <p>{t.noData}</p>
          </div>
        )}
      </div>
    </section>
  );
}
