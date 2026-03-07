import { useMemo, useState } from "react";
import { useTranslation } from "@/hooks/i18n";
import type {
  ProjectDetail,
  SessionRecord,
  TaskTreeNode,
  LockRecord,
  EventRecord,
  AgentIOTimelineItem,
  SendMessageRequest
} from "@/types";
import { projectApi } from "@/services/api";
import { ChevronDown, ChevronRight, Send, Loader } from "lucide-react";

interface AgentIOViewProps {
  projectId: string;
  project: ProjectDetail | null;
  sessions: SessionRecord[];
  tasks: TaskTreeNode[];
  locks: LockRecord[];
  events: EventRecord[];
  timeline: AgentIOTimelineItem[];
  reload: () => void;
}

interface TimelineItem {
  id: string;
  kind: string;
  createdAt: string;
  from?: string;
  toRole?: string;
  toSessionId?: string;
  messageType?: string;
  content?: string;
  requestId?: string;
  messageId?: string;
  status?: string;
  runId?: string;
  discussThreadId?: string;
  taskId?: string;
}

export function AgentIOView({ projectId, project, sessions, timeline: rawTimeline, reload }: AgentIOViewProps) {
  const t = useTranslation();
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [kindFilter, setKindFilter] = useState<string>("all");

  const [showSendForm, setShowSendForm] = useState(false);
  const [fromAgent, setFromAgent] = useState<string>("user");
  const [toRole, setToRole] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("auto");
  const [content, setContent] = useState("");
  const [messageType, setMessageType] = useState<string>("MANAGER_MESSAGE");
  const [taskId, setTaskId] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);

  const agentIds = project?.agentIds ?? [];
  const availableRoles =
    agentIds.length > 0 ? agentIds : sessions.map((s) => s.role).filter((v, i, a) => a.indexOf(v) === i);

  const timeline: TimelineItem[] = useMemo(() => {
    return rawTimeline.map((item) => {
      const raw = item as unknown as Record<string, unknown>;
      return {
        id: (raw.itemId ?? raw.id ?? raw.ioId) as string,
        kind: (raw.kind ?? raw.messageType ?? "unknown") as string,
        createdAt: (raw.createdAt ?? raw.created_at) as string,
        from: raw.from as string | undefined,
        toRole: raw.toRole as string | undefined,
        toSessionId: raw.toSessionId as string | undefined,
        messageType: (raw.messageType ?? raw.message_type) as string | undefined,
        content: raw.content as string | undefined,
        requestId: raw.requestId as string | undefined,
        messageId: raw.messageId as string | undefined,
        status: raw.status as string | undefined,
        runId: raw.runId as string | undefined,
        discussThreadId: (raw.discussThreadId ?? raw.discuss_thread_id) as string | undefined,
        taskId: (raw.taskId ?? raw.task_id) as string | undefined
      };
    });
  }, [rawTimeline]);

  const filteredTimeline = useMemo(() => {
    if (kindFilter === "all") return timeline;
    return timeline.filter((item) => item.kind === kindFilter);
  }, [timeline, kindFilter]);

  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of timeline) {
      counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    }
    return counts;
  }, [timeline]);

  const toggleExpand = (id: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const onSend = async () => {
    if (!toRole || !content.trim()) {
      setSendError("Target role and content are required");
      return;
    }

    setSending(true);
    setSendError(null);
    setSendSuccess(null);

    try {
      const body: SendMessageRequest = {
        from_agent: fromAgent,
        to: { agent: toRole, session_id: sessionId === "auto" ? null : sessionId },
        content: content.trim(),
        message_type: messageType as SendMessageRequest["message_type"]
      };

      if (taskId.trim()) {
        body.task_id = taskId.trim();
      }

      await projectApi.sendMessage(projectId, body);
      setSendSuccess("Message sent successfully");
      setContent("");
      setTaskId("");
      reload();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const kindColors: Record<string, string> = {
    user_message: "var(--accent-primary)",
    message_routed: "var(--accent-secondary)",
    task_action: "var(--accent-warning)",
    task_discuss: "var(--accent-secondary)",
    task_report: "var(--accent-success)",
    dispatch_started: "var(--accent-success)",
    dispatch_finished: "var(--text-muted)",
    dispatch_failed: "var(--accent-danger)"
  };

  const kindLabels: Record<string, string> = {
    user_message: "User Message",
    message_routed: "Message Routed",
    task_action: "Task Action",
    task_discuss: "Discussion",
    task_report: "Task Report",
    dispatch_started: "Dispatch Started",
    dispatch_finished: "Dispatch Finished",
    dispatch_failed: "Dispatch Failed"
  };

  const kindDescriptions: Record<string, string> = {
    user_message: "User sent a message to agent",
    message_routed: "Message was routed to target agent",
    task_action: "Agent performed a task action",
    task_discuss: "Task discussion message",
    task_report: "Agent reported task progress",
    dispatch_started: "Message dispatch was initiated",
    dispatch_finished: "Message dispatch completed",
    dispatch_failed: "Message dispatch failed"
  };

  return (
    <section style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <h1>{t.agentIO}</h1>
        <button className="btn btn-primary" onClick={() => setShowSendForm(!showSendForm)}>
          <Send size={16} />
          Send Message
        </button>
      </div>

      {showSendForm && (
        <div className="card" style={{ flexShrink: 0 }}>
          <div className="card-header">
            <h3>Send Message to Agent</h3>
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "16px" }}>
            Use this form to send general messages (MANAGER_MESSAGE, TASK_DISCUSS). For task actions (TASK_CREATE,
            TASK_ASSIGN, TASK_REPORT), use Task Actions view.
          </p>

          {sendError && <div className="error-message">{sendError}</div>}
          {sendSuccess && <div className="success-message">{sendSuccess}</div>}

          <div className="grid grid-2">
            <div className="form-group">
              <label>From</label>
              <select value={fromAgent} onChange={(e) => setFromAgent(e.target.value)}>
                <option value="user">User</option>
                <option value="manager">Manager</option>
                <option value="system">System</option>
              </select>
            </div>
            <div className="form-group">
              <label>To Role *</label>
              <select value={toRole} onChange={(e) => setToRole(e.target.value)}>
                <option value="">-- Select role --</option>
                {availableRoles.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-2">
            <div className="form-group">
              <label>Session</label>
              <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                <option value="auto">Auto (latest)</option>
                {sessions
                  .filter((s) => s.role === toRole)
                  .map((s) => (
                    <option key={s.sessionId} value={s.sessionId}>
                      {s.sessionId.slice(0, 16)}... ({s.status})
                    </option>
                  ))}
              </select>
            </div>
            <div className="form-group">
              <label>Message Type</label>
              <select value={messageType} onChange={(e) => setMessageType(e.target.value)}>
                <option value="MANAGER_MESSAGE">MANAGER_MESSAGE</option>
                <option value="TASK_DISCUSS_REQUEST">TASK_DISCUSS_REQUEST</option>
                <option value="TASK_DISCUSS_REPLY">TASK_DISCUSS_REPLY</option>
                <option value="TASK_DISCUSS_CLOSED">TASK_DISCUSS_CLOSED</option>
              </select>
            </div>
          </div>

          <div className="form-group">
            <label>Task ID (optional)</label>
            <input value={taskId} onChange={(e) => setTaskId(e.target.value)} placeholder="task-id" />
          </div>

          <div className="form-group">
            <label>Content *</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              style={{ minHeight: "100px" }}
              placeholder="Enter your message..."
            />
          </div>

          <button className="btn btn-primary" onClick={onSend} disabled={sending || !toRole || !content.trim()}>
            {sending ? <Loader size={14} className="loading-spinner" /> : <Send size={14} />}
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      )}

      <div
        className="card"
        data-scrollable
        style={{
          flex: "1",
          minHeight: 0
        }}
      >
        <div className="card-header" style={{ flexShrink: 0 }}>
          <h3>{t.agentIO}</h3>
          <span className="badge badge-neutral">{filteredTimeline.length}</span>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            paddingRight: "4px"
          }}
        >
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", flexShrink: 0 }}>
            <button
              className={`btn btn-sm ${kindFilter === "all" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setKindFilter("all")}
            >
              All ({timeline.length})
            </button>
            {Object.entries(kindCounts).map(([kind, count]) => (
              <button
                key={kind}
                className={`btn btn-sm ${kindFilter === kind ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setKindFilter(kind)}
              >
                {kindLabels[kind] || kind} ({count})
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {filteredTimeline.length === 0 ? (
              <div className="empty-state" style={{ padding: "24px" }}>
                <p>{t.noData}</p>
              </div>
            ) : (
              filteredTimeline.slice(0, 200).map((item) => {
                const isExpanded = expandedItems.has(item.id);

                return (
                  <div
                    key={item.id}
                    style={{
                      background: "var(--bg-elevated)",
                      borderRadius: "8px",
                      borderLeft: `4px solid ${kindColors[item.kind] || "var(--text-muted)"}`,
                      overflow: "hidden"
                    }}
                  >
                    <div
                      style={{
                        padding: "12px 16px",
                        minHeight: "48px",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        cursor: "pointer"
                      }}
                      onClick={() => toggleExpand(item.id)}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        <span
                          className="badge"
                          style={{
                            background: kindColors[item.kind] || "var(--text-muted)",
                            minWidth: "100px",
                            justifyContent: "center"
                          }}
                        >
                          {kindLabels[item.kind] || item.kind}
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
                          {item.from && <span style={{ fontWeight: 600 }}>{item.from}</span>}
                          {item.from && item.toRole && <span style={{ color: "var(--text-muted)" }}>→</span>}
                          {item.toRole && (
                            <span style={{ fontWeight: 600, color: "var(--accent-primary)" }}>{item.toRole}</span>
                          )}
                          {!item.from && !item.toRole && (
                            <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>
                              {kindDescriptions[item.kind] || "System event"}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                        {item.status && (
                          <span
                            className={`badge ${item.status === "done" ? "badge-success" : item.status === "running" ? "badge-warning" : "badge-neutral"}`}
                          >
                            {item.status}
                          </span>
                        )}
                        <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                          {new Date(item.createdAt).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {isExpanded && (
                      <div
                        style={{
                          padding: "0 16px 16px",
                          borderTop: "1px solid var(--border-color)",
                          marginLeft: "28px"
                        }}
                      >
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(2, 1fr)",
                            gap: "12px",
                            marginTop: "12px"
                          }}
                        >
                          {item.messageType && (
                            <div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "2px" }}>
                                Message Type
                              </div>
                              <span className="badge badge-secondary">{item.messageType}</span>
                            </div>
                          )}
                          {item.requestId && (
                            <div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "2px" }}>
                                Request ID
                              </div>
                              <code style={{ fontSize: "11px" }}>{item.requestId}</code>
                            </div>
                          )}
                          {item.messageId && (
                            <div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "2px" }}>
                                Message ID
                              </div>
                              <code style={{ fontSize: "11px" }}>{item.messageId}</code>
                            </div>
                          )}
                          {item.runId && (
                            <div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "2px" }}>
                                Run ID
                              </div>
                              <code style={{ fontSize: "11px" }}>{item.runId}</code>
                            </div>
                          )}
                          {item.taskId && (
                            <div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "2px" }}>
                                Task ID
                              </div>
                              <code style={{ fontSize: "11px" }}>{item.taskId}</code>
                            </div>
                          )}
                          {item.toSessionId && (
                            <div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "2px" }}>
                                Target Session
                              </div>
                              <code style={{ fontSize: "11px" }}>{item.toSessionId}</code>
                            </div>
                          )}
                          {item.discussThreadId && (
                            <div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "2px" }}>
                                Discussion Thread
                              </div>
                              <code style={{ fontSize: "11px" }}>{item.discussThreadId}</code>
                            </div>
                          )}
                        </div>

                        {item.content && (
                          <div style={{ marginTop: "12px" }}>
                            <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px" }}>
                              Content
                            </div>
                            <pre
                              style={{
                                padding: "12px",
                                background: "var(--bg-surface)",
                                borderRadius: "6px",
                                fontSize: "12px",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                maxHeight: "300px",
                                overflow: "auto",
                                margin: 0
                              }}
                            >
                              {item.content}
                            </pre>
                          </div>
                        )}

                        {!item.content && !item.requestId && !item.messageId && !item.runId && !item.taskId && (
                          <div style={{ marginTop: "12px", color: "var(--text-muted)", fontSize: "12px" }}>
                            No additional details available
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
