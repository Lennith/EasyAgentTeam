import type { ReactNode } from "react";
import { X } from "lucide-react";
import type { AgentIOTimelineItem } from "@/types";
import type { TaskLifecycleEvent } from "@/types";

interface MiniMaxLogItem {
  id: string;
  kind: string;
  startTime: string;
  endTime?: string;
  status: "running" | "completed" | "failed";
  from?: string;
  toRole?: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
}

interface TaskDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  children?: ReactNode;
  timeline?: AgentIOTimelineItem[];
  createParams?: Record<string, unknown>;
  minimaxLogEvents?: TaskLifecycleEvent[];
}

function combineMiniMaxLogs(timeline: AgentIOTimelineItem[]): MiniMaxLogItem[] {
  // 合并逻辑：按时间顺序遍历，把所有非 dispatch 事件连续出现的事件合并成一条
  // A (dispatch_started) -> B (其他事件，合并) -> C (其他事件) -> D (dispatch_finished)
  
  const logs: MiniMaxLogItem[] = [];
  let currentLog: MiniMaxLogItem | null = null;
  
  // 按时间排序 timeline
  const sortedTimeline = [...timeline].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  
  for (const item of sortedTimeline) {
    const raw = item as unknown as Record<string, unknown>;
    const kind = (raw.kind as string) || "";
    
    // A 或 D 事件 - dispatch 开始/结束
    if (kind === "dispatch_started") {
      // 如果有之前的日志，先保存
      if (currentLog) {
        logs.push(currentLog);
        currentLog = null;
      }
      // 创建新的 dispatch 日志
      currentLog = {
        id: `dispatch-${item.id}`,
        kind: kind,
        startTime: item.createdAt,
        status: "running",
        from: item.from,
        toRole: item.toRole,
        runId: raw.runId as string | undefined,
        taskId: item.taskId,
      };
    } else if (kind === "dispatch_finished") {
      // 找到对应的 dispatch started 日志并更新
      const existingLog = logs.find(l => l.kind === "dispatch_started" && l.runId === raw.runId);
      if (existingLog) {
        existingLog.endTime = item.createdAt;
        existingLog.status = item.status === "failed" ? "failed" : "completed";
      } else if (currentLog) {
        // 关闭当前日志
        currentLog.endTime = item.createdAt;
        currentLog.status = item.status === "failed" ? "failed" : "completed";
        logs.push(currentLog);
        currentLog = null;
      }
    } else {
      // B 或 C 事件 - 合并其他类型的事件
      if (currentLog && currentLog.kind !== "dispatch_started") {
        // 已经是合并的日志，更新 endTime
        currentLog.endTime = item.createdAt;
      } else if (currentLog && currentLog.kind === "dispatch_started") {
        // 从 dispatch 开始切换到其他类型，开始新的合并
        logs.push(currentLog);
        currentLog = {
          id: `merged-${item.id}`,
          kind: kind || "merged",
          startTime: item.createdAt,
          status: "running",
          from: item.from,
          toRole: item.toRole,
          runId: raw.runId as string | undefined,
          taskId: item.taskId,
        };
      } else {
        // 开始新的合并日志
        currentLog = {
          id: `merged-${item.id}`,
          kind: kind || "merged",
          startTime: item.createdAt,
          status: "running",
          from: item.from,
          toRole: item.toRole,
          runId: raw.runId as string | undefined,
          taskId: item.taskId,
        };
      }
    }
  }
  
  // 添加最后一个未完成的日志
  if (currentLog) {
    logs.push(currentLog);
  }

  return logs.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
}

// Helper to format param value for display
function formatParamValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function RenderMinimaxLogEvents({ events }: { events: TaskLifecycleEvent[] }) {
  if (events.length === 0) return null;

  const contentByStream: Record<string, string[]> = {};
  events.forEach(e => {
    const stream = (e.payload?.stream as string) || "other";
    const content = (e.payload?.content as string) || "";
    if (!contentByStream[stream]) contentByStream[stream] = [];
    contentByStream[stream].push(content);
  });

  const firstTime = events[0]?.created_at ? new Date(events[0].created_at).toLocaleString() : "";
  const lastTime = events[events.length - 1]?.created_at ? new Date(events[events.length - 1].created_at).toLocaleString() : "";

  const streamEntries = Object.entries(contentByStream);
  const lastIdx = streamEntries.length - 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", flex: 1, minHeight: 0 }}>
      <div style={{ fontSize: "14px", color: "var(--text-muted)", marginBottom: "4px" }}>
        {events.length} logs | {firstTime} - {lastTime}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", flex: 1, minHeight: 0, overflow: "hidden" }}>
        {streamEntries.map(([stream, contents], idx) => (
          <div 
            key={stream} 
            style={{ 
              padding: "12px", 
              background: "var(--bg-surface)", 
              borderRadius: "6px",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              flex: idx === lastIdx ? 1 : "none",
              overflow: "hidden",
            }}
          >
            <div style={{ fontSize: "14px", color: "var(--text-muted)", marginBottom: "8px", fontWeight: 500, flexShrink: 0 }}>
              {stream.toUpperCase()} ({contents.length} lines)
            </div>
            <pre style={{ fontSize: "14px", overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0, flex: 1 }}>
              {contents.join("\n")}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TaskDetailsModal({ isOpen, onClose, children, timeline = [], createParams, minimaxLogEvents }: TaskDetailsModalProps) {
  if (!isOpen) return null;

  const miniMaxLogs = combineMiniMaxLogs(timeline);

  // Filter non-empty create params
  const nonEmptyParams = createParams 
    ? Object.entries(createParams).filter(([, value]) => {
        if (value === null || value === undefined) return false;
        if (typeof value === "string" && value.trim() === "") return false;
        if (Array.isArray(value) && value.length === 0) return false;
        if (typeof value === "object" && Object.keys(value as Record<string, unknown>).length === 0) return false;
        return true;
      })
    : [];

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const statusColors: Record<string, string> = {
    running: "var(--accent-warning)",
    completed: "var(--accent-success)",
    failed: "var(--accent-danger)",
  };

  return (
    <div
      onClick={handleBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          width: "50vw",
          height: "66vh",
          display: "flex",
          flexDirection: "column",
          background: "rgba(26, 26, 26, 0.8)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          borderRadius: "12px",
          border: "1px solid var(--border-color)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            padding: "12px 16px",
            borderBottom: "1px solid var(--border-color)",
            flexShrink: 0,
          }}
        >
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              padding: "4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "4px",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-secondary)";
            }}
          >
            <X size={20} />
          </button>
        </div>
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "16px",
          }}
        >
          {/* Create Parameters Section - Full JSON Display */}
          {createParams && (
            <div style={{ marginBottom: "16px" }}>
              <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px", color: "var(--text-primary)" }}>
                Task Create Parameters
              </div>
              <div style={{ 
                padding: "16px", 
                background: "var(--bg-surface)", 
                borderRadius: "8px",
                overflow: "auto",
                maxHeight: "60vh",
                border: "1px solid var(--border-color)",
              }}>
                <pre style={{ 
                  fontSize: "13px", 
                  lineHeight: "1.6",
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "var(--text-primary)",
                }}>
                  {JSON.stringify(createParams, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {/* MiniMaxLog Events from TaskTreeView */}
          {minimaxLogEvents && minimaxLogEvents.length > 0 && (
            <div style={{ marginBottom: "16px" }}>
              <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px", color: "var(--text-primary)" }}>
                MiniMax Logs
              </div>
              <RenderMinimaxLogEvents events={minimaxLogEvents} />
            </div>
          )}

          {/* Timeline-based MiniMax Logs */}
          {miniMaxLogs.length > 0 && (
            <div style={{ marginBottom: "16px" }}>
              <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px", color: "var(--text-primary)" }}>
                Timeline Logs
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {miniMaxLogs.map((log) => (
                  <div
                    key={log.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      padding: "10px 14px",
                      background: "var(--bg-elevated)",
                      borderRadius: "8px",
                      fontSize: "14px",
                    }}
                  >
                    <span
                      className="badge"
                      style={{
                        background: statusColors[log.status] || "var(--text-muted)",
                        fontSize: "13px",
                        padding: "4px 10px",
                      }}
                    >
                      {log.status}
                    </span>
                    <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>
                      {log.from && <span>{log.from}</span>}
                      {log.from && log.toRole && <span style={{ color: "var(--text-muted)", margin: "0 6px" }}>→</span>}
                      {log.toRole && <span style={{ color: "var(--accent-primary)" }}>{log.toRole}</span>}
                    </span>
                    <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>
                      {new Date(log.startTime).toLocaleTimeString()}
                      {log.endTime && <span> - {new Date(log.endTime).toLocaleTimeString()}</span>}
                    </span>
                    {log.runId && (
                      <code style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                        {log.runId.slice(0, 12)}...
                      </code>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
