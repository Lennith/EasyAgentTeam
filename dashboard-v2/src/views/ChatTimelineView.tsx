import { useTranslation } from "@/hooks/i18n";
import type { ProjectDetail, SessionRecord, TaskTreeNode, LockRecord, EventRecord, AgentIOTimelineItem } from "@/types";

interface ChatTimelineViewProps {
  projectId: string;
  project: ProjectDetail | null;
  sessions: SessionRecord[];
  tasks: TaskTreeNode[];
  locks: LockRecord[];
  events: EventRecord[];
  timeline: AgentIOTimelineItem[];
  reload: () => void;
}

export function ChatTimelineView({ timeline }: ChatTimelineViewProps) {
  const t = useTranslation();

  const messageItems = timeline.filter((item) => {
    const raw = item as unknown as Record<string, unknown>;
    const kind = (raw.kind ?? item.messageType) as string;
    const content = raw.content as string | undefined;
    
    if (kind === "user_message" || kind === "message_routed") {
      return true;
    }
    if (kind === "dispatch_started" && content && content.trim().length > 0) {
      return true;
    }
    if (kind === "task_discuss" && content && content.trim().length > 0) {
      return true;
    }
    return false;
  });

  const kindColors: Record<string, string> = {
    user_message: "var(--accent-primary)",
    message_routed: "var(--accent-secondary)",
    dispatch_started: "var(--accent-success)",
    task_discuss: "var(--accent-secondary)",
  };

  const kindLabels: Record<string, string> = {
    user_message: "User Message",
    message_routed: "Message Routed",
    dispatch_started: "Dispatch",
    task_discuss: "Discussion",
  };

  return (
    <section>
      <div className="page-header">
        <h1>{t.chatTimeline}</h1>
      </div>

      <div className="card" data-scrollable>
        <div className="card-header">
          <h3>{t.chatMessages}</h3>
          <span className="badge badge-neutral">{messageItems.length}</span>
        </div>

        {messageItems.length === 0 ? (
          <div className="empty-state" style={{ padding: "24px" }}>
            <p>{t.noData}</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {messageItems.map((item) => {
              const raw = item as unknown as Record<string, unknown>;
              const content = (raw.content ?? item.summary) as string | undefined;
              const from = raw.from as string | undefined;
              const toRole = raw.toRole as string | undefined;
              const kind = (raw.kind ?? item.messageType) as string;
              const status = raw.status as string | undefined;
              const runId = raw.runId as string | undefined;
              
              return (
                <div 
                  key={item.id} 
                  style={{ 
                    padding: "16px", 
                    background: "var(--bg-elevated)", 
                    borderRadius: "8px",
                    borderLeft: `4px solid ${kindColors[kind] || "var(--text-muted)"}`
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <span 
                        className="badge" 
                        style={{ background: kindColors[kind] || "var(--text-muted)", fontSize: "11px" }}
                      >
                        {kindLabels[kind] || kind}
                      </span>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
                        {from && (
                          <>
                            <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{from}</span>
                          </>
                        )}
                        {from && toRole && (
                          <span style={{ color: "var(--text-muted)" }}>→</span>
                        )}
                        {toRole && (
                          <span style={{ fontWeight: 600, color: "var(--accent-primary)" }}>{toRole}</span>
                        )}
                      </div>
                    </div>
                    <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                      {new Date(item.createdAt).toLocaleString()}
                    </span>
                  </div>
                  
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px" }}>
                    {item.messageType && (
                      <span className="badge badge-secondary" style={{ fontSize: "10px" }}>{item.messageType}</span>
                    )}
                    {status && (
                      <span className={`badge ${status === "done" ? "badge-success" : status === "running" ? "badge-warning" : "badge-neutral"}`} style={{ fontSize: "10px" }}>
                        {status}
                      </span>
                    )}
                    {runId && (
                      <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>Run: {runId.slice(0, 8)}</span>
                    )}
                  </div>
                  
                  {content && (
                    <div style={{ 
                      fontSize: "14px", 
                      lineHeight: 1.6,
                      padding: "12px",
                      background: "var(--bg-surface)",
                      borderRadius: "6px",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}>
                      {content}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
