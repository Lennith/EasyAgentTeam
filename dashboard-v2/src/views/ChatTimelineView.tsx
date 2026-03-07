import { useMemo, useState } from "react";
import { useTranslation } from "@/hooks/i18n";
import type { ProjectDetail, SessionRecord, TaskTreeNode, LockRecord, EventRecord, AgentIOTimelineItem } from "@/types";

interface ChatTimelineViewProps {
  projectId?: string;
  project?: ProjectDetail | null;
  sessions?: SessionRecord[];
  tasks?: TaskTreeNode[];
  locks?: LockRecord[];
  events?: EventRecord[];
  timeline: AgentIOTimelineItem[];
  reload?: () => void;
}

type TimelineMode = "all" | "main";

function readKind(item: AgentIOTimelineItem): string {
  const raw = item as unknown as Record<string, unknown>;
  return String(raw.kind ?? item.messageType ?? "").trim();
}

function readContent(item: AgentIOTimelineItem): string {
  const raw = item as unknown as Record<string, unknown>;
  return String(raw.content ?? item.summary ?? "").trim();
}

function readRequestId(item: AgentIOTimelineItem): string {
  const raw = item as unknown as Record<string, unknown>;
  return String(raw.requestId ?? "").trim();
}

function readFrom(item: AgentIOTimelineItem): string {
  const raw = item as unknown as Record<string, unknown>;
  return String(raw.originAgent ?? raw.from ?? item.role ?? "").trim();
}

function readToRole(item: AgentIOTimelineItem): string {
  const raw = item as unknown as Record<string, unknown>;
  return String(raw.toRole ?? item.toRole ?? "").trim();
}

function isManagerActor(actor: string): boolean {
  return actor.trim().toLowerCase() === "manager";
}

export function ChatTimelineView({ timeline }: ChatTimelineViewProps) {
  const t = useTranslation();
  const [mode, setMode] = useState<TimelineMode>("main");

  const filteredItems = useMemo(() => {
    return timeline.filter((item) => {
      const kind = readKind(item);
      const content = readContent(item);

      if (kind === "user_message" || kind === "message_routed") {
        return true;
      }
      if (kind === "dispatch_started" && content.length > 0) {
        return true;
      }
      if (kind === "task_discuss" && content.length > 0) {
        return true;
      }
      if (kind.startsWith("task_")) {
        return true;
      }
      if ((item.messageType ?? "").startsWith("TASK_")) {
        return true;
      }
      return false;
    });
  }, [timeline]);

  const mergedItems = useMemo(() => {
    const sorted = [...filteredItems].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const pendingUserByRequest = new Map<string, AgentIOTimelineItem>();
    const consumedUserIds = new Set<string>();
    const merged: AgentIOTimelineItem[] = [];

    for (const item of sorted) {
      const raw = item as unknown as Record<string, unknown>;
      const kind = readKind(item);
      const requestId = readRequestId(item);
      const isUserMsg = kind === "user_message";
      const isRouted = kind === "message_routed" || kind === "task_discuss";

      if (isUserMsg && requestId) {
        pendingUserByRequest.set(requestId, item);
        continue;
      }

      if (isRouted && requestId && pendingUserByRequest.has(requestId)) {
        const userItem = pendingUserByRequest.get(requestId)!;
        const userRaw = userItem as unknown as Record<string, unknown>;
        const mergedFrom = String(
          userRaw.originAgent ?? userRaw.from ?? raw.originAgent ?? raw.from ?? item.role ?? ""
        ).trim();

        const mergedItem: AgentIOTimelineItem = {
          ...item,
          role: mergedFrom || item.role,
          from: mergedFrom || (raw.from as string | undefined),
          toRole: (raw.toRole as string | undefined) ?? (userRaw.toRole as string | undefined) ?? item.toRole,
          summary: (raw.content as string | undefined) ?? (userRaw.content as string | undefined) ?? item.summary
        };

        consumedUserIds.add(userItem.id);
        pendingUserByRequest.delete(requestId);
        merged.push(mergedItem);
        continue;
      }

      merged.push(item);
    }

    return merged.filter((item) => !consumedUserIds.has(item.id));
  }, [filteredItems]);

  const messageItems = useMemo(() => {
    if (mode === "all") {
      return mergedItems;
    }

    return mergedItems.filter((item) => {
      const kind = readKind(item);
      const messageType = (item.messageType ?? "").toUpperCase();
      const from = readFrom(item);
      const content = readContent(item).toLowerCase();

      if (kind === "task_action") {
        if (messageType === "TASK_CREATE") {
          return !isManagerActor(from);
        }
        return false;
      }

      if (kind === "task_report") {
        return content.includes("applied") && content.includes("updated");
      }

      if ((kind === "task_create" || messageType === "TASK_CREATE") && isManagerActor(from)) {
        return false;
      }

      return kind !== "dispatch_started" && kind !== "dispatch_finished" && kind !== "dispatch_failed";
    });
  }, [mergedItems, mode]);

  const kindColors: Record<string, string> = {
    user_message: "var(--accent-primary)",
    message_routed: "var(--accent-secondary)",
    dispatch_started: "var(--accent-success)",
    task_discuss: "var(--accent-secondary)"
  };

  const kindLabels: Record<string, string> = {
    user_message: "User Message",
    message_routed: "Message Routed",
    dispatch_started: "Dispatch",
    task_discuss: "Discussion",
    task_create: "Task Create",
    task_update: "Task Update",
    task_assign: "Task Assign",
    task_report: "Task Report"
  };

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <h1>{t.chatTimeline}</h1>
      </div>

      <div
        className="card"
        data-scrollable
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div className="card-header">
          <h3>{t.chatMessages}</h3>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              className={`btn btn-sm ${mode === "main" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setMode("main")}
            >
              Main
            </button>
            <button
              className={`btn btn-sm ${mode === "all" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setMode("all")}
            >
              ALL
            </button>
            <span className="badge badge-neutral">{messageItems.length}</span>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingRight: "4px" }}>
          {messageItems.length === 0 ? (
            <div className="empty-state" style={{ padding: "24px" }}>
              <p>{t.noData}</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {messageItems.map((item) => {
                const raw = item as unknown as Record<string, unknown>;
                const content = readContent(item);
                const from = readFrom(item);
                const toRole = readToRole(item);
                const kind = readKind(item);
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
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: "8px"
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <span
                          className="badge"
                          style={{ background: kindColors[kind] || "var(--text-muted)", fontSize: "11px" }}
                        >
                          {kindLabels[kind] || kind}
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
                          {from && <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{from}</span>}
                          {from && toRole && <span style={{ color: "var(--text-muted)" }}>-&gt;</span>}
                          {toRole && <span style={{ fontWeight: 600, color: "var(--accent-primary)" }}>{toRole}</span>}
                        </div>
                      </div>
                      <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                        {new Date(item.createdAt).toLocaleString()}
                      </span>
                    </div>

                    <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px" }}>
                      {item.messageType && (
                        <span className="badge badge-secondary" style={{ fontSize: "10px" }}>
                          {item.messageType}
                        </span>
                      )}
                      {status && (
                        <span
                          className={`badge ${status === "done" ? "badge-success" : status === "running" ? "badge-warning" : "badge-neutral"}`}
                          style={{ fontSize: "10px" }}
                        >
                          {status}
                        </span>
                      )}
                      {runId && (
                        <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>Run: {runId.slice(0, 8)}</span>
                      )}
                    </div>

                    {content && (
                      <div
                        style={{
                          fontSize: "14px",
                          lineHeight: 1.6,
                          padding: "12px",
                          background: "var(--bg-surface)",
                          borderRadius: "6px",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word"
                        }}
                      >
                        {content}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
