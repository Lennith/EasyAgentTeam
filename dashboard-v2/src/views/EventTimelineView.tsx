import { useTranslation } from "@/hooks/i18n";
import type { ProjectDetail, SessionRecord, TaskTreeNode, LockRecord, EventRecord, AgentIOTimelineItem } from "@/types";

interface EventTimelineViewProps {
  projectId: string;
  project: ProjectDetail | null;
  sessions: SessionRecord[];
  tasks: TaskTreeNode[];
  locks: LockRecord[];
  events: EventRecord[];
  timeline: AgentIOTimelineItem[];
  reload: () => void;
}

export function EventTimelineView({ events }: EventTimelineViewProps) {
  const t = useTranslation();

  return (
    <section>
      <div className="page-header">
        <h1>{t.eventTimeline}</h1>
      </div>

      <div className="card" data-scrollable>
        {events.length === 0 ? (
          <div className="empty-state" style={{ padding: "24px" }}>
            <p>{t.noData}</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {events.slice(-100).reverse().map((event) => (
              <div 
                key={event.eventId} 
                style={{ 
                  padding: "12px", 
                  background: "var(--bg-elevated)", 
                  borderRadius: "6px",
                  fontSize: "12px"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                  <span className="badge badge-primary">{event.eventType}</span>
                  <span style={{ color: "var(--text-muted)" }}>{new Date(event.createdAt).toLocaleString()}</span>
                </div>
                <div style={{ color: "var(--text-secondary)" }}>
                  Source: {event.source}
                  {event.sessionId && <span> | Session: {event.sessionId.slice(0, 20)}...</span>}
                </div>
                {event.payload && Object.keys(event.payload).length > 0 && (
                  <pre style={{ margin: "8px 0 0", fontSize: "11px", color: "var(--text-muted)" }}>
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
