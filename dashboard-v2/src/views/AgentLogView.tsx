import { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "@/hooks/i18n";
import { useSettings } from "@/hooks/useSettings";
import type { ProjectSummary } from "@/types";
import { projectApi } from "@/services/api";
import * as mockData from "@/mock/data";
import { Loader, Bug, Play, Pause, RotateCcw, ChevronDown, ChevronRight, FileCode } from "lucide-react";

interface JsonlLine {
  sessionId: string;
  stream: string;
  content: string;
  timestamp: string;
  timestampMs: number;
}

interface SessionData {
  id: string;
  role: string;
  streams: Record<string, JsonlLine[]>;
  firstSeen: string;
  lastSeen: string;
}

interface TimeBlock {
  startTime: string;
  startTimeMs: number;
  items: JsonlLine[];
}

const REFRESH_INTERVAL = 3000;
const MERGE_WINDOW_MS = 30 * 1000;
const streamOrder = ["system", "stderr", "stdout", "response", "other"];

function extractRole(sessionId: string): string {
  if (sessionId.startsWith("sess-")) {
    const match = sessionId.match(/sess-(\w+)-/);
    if (match) return match[1];
  }
  if (sessionId.includes("dev")) return "dev";
  if (sessionId.includes("leader")) return "leader";
  if (sessionId.includes("manager")) return "manager";
  return sessionId.split("-")[0] || sessionId;
}

function formatTime(isoString: string): string {
  if (!isoString) return "";
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return isoString;
  }
}

function groupByTimeWindow(items: JsonlLine[]): TimeBlock[] {
  if (!items || items.length === 0) return [];

  const groups: TimeBlock[] = [];
  let currentGroup: TimeBlock | null = null;

  items.forEach((item) => {
    const ts = item.timestampMs || 0;

    if (!currentGroup) {
      currentGroup = {
        startTime: item.timestamp,
        startTimeMs: ts,
        items: [item]
      };
    } else if (ts > 0 && currentGroup.startTimeMs > 0 && ts - currentGroup.startTimeMs <= MERGE_WINDOW_MS) {
      currentGroup.items.push(item);
    } else {
      groups.push(currentGroup);
      currentGroup = {
        startTime: item.timestamp,
        startTimeMs: ts,
        items: [item]
      };
    }
  });

  if (currentGroup) {
    groups.push(currentGroup);
  }

  return groups;
}

function parseDiffBlocks(lines: JsonlLine[]): { type: string; data?: unknown; lines?: JsonlLine[] }[] {
  const blocks: { type: string; data?: unknown; lines?: JsonlLine[] }[] = [];
  let currentBlock: { fileName: string; header: string; lines: { type: string; content: string }[] } | null = null;
  const normalLines: JsonlLine[] = [];

  lines.forEach((item) => {
    const content = item.content;

    if (content.startsWith("diff --git ") || content.startsWith("diff -")) {
      if (currentBlock) {
        blocks.push({ type: "diff", data: currentBlock });
        currentBlock = null;
      }
      if (normalLines.length > 0) {
        blocks.push({ type: "normal", lines: [...normalLines] });
        normalLines.length = 0;
      }

      const fileMatch = content.match(/diff --git a\/(.+?) b\//);
      const fileName = fileMatch ? fileMatch[1] : "unknown";

      currentBlock = {
        fileName,
        header: content,
        lines: []
      };
    } else if (currentBlock) {
      if (content.startsWith("@@")) {
        currentBlock.lines.push({ type: "hunk", content });
      } else if (content.startsWith("+") && !content.startsWith("+++")) {
        currentBlock.lines.push({ type: "add", content });
      } else if (content.startsWith("-") && !content.startsWith("---")) {
        currentBlock.lines.push({ type: "del", content });
      } else if (content.startsWith("index ") || content.startsWith("---") || content.startsWith("+++")) {
        currentBlock.lines.push({ type: "info", content });
      } else {
        currentBlock.lines.push({ type: "ctx", content });
      }
    } else {
      normalLines.push(item);
    }
  });

  if (currentBlock) {
    blocks.push({ type: "diff", data: currentBlock });
  } else if (normalLines.length > 0) {
    blocks.push({ type: "normal", lines: [...normalLines] });
  }

  return blocks;
}

function DiffBlock({ data }: { data: { fileName: string; lines: { type: string; content: string }[] } }) {
  const addCount = data.lines.filter((l) => l.type === "add").length;
  const delCount = data.lines.filter((l) => l.type === "del").length;

  return (
    <div style={{
      margin: "8px 0",
      border: "1px solid var(--border-color)",
      borderRadius: "6px",
      overflow: "hidden",
      background: "var(--bg-surface)"
    }}>
      <div style={{
        background: "var(--bg-elevated)",
        padding: "6px 10px",
        fontSize: "11px",
        color: "var(--text-secondary)",
        borderBottom: "1px solid var(--border-color)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center"
      }}>
        <span style={{ color: "var(--accent-warning)" }}>{data.fileName}</span>
        <span style={{ color: "var(--text-muted)" }}>+{addCount} -{delCount}</span>
      </div>
      <div style={{ padding: "5px 10px", fontSize: "11px", lineHeight: 1.3, overflowX: "auto" }}>
        {data.lines.map((line, idx) => {
          let bg = "";
          let color = "var(--text-primary)";
          if (line.type === "add") {
            bg = "rgba(34, 197, 94, 0.1)";
            color = "var(--accent-success)";
          } else if (line.type === "del") {
            bg = "rgba(239, 68, 68, 0.1)";
            color = "var(--accent-danger)";
          } else if (line.type === "hunk") {
            bg = "rgba(59, 130, 246, 0.1)";
            color = "var(--accent-primary)";
          } else if (line.type === "info") {
            color = "var(--text-muted)";
          }
          return (
            <div key={idx} style={{ whiteSpace: "pre", display: "flex", background: bg }}>
              <span style={{ color: "var(--text-muted)", minWidth: "30px", textAlign: "right", marginRight: "10px", fontSize: "10px" }}>{idx + 1}</span>
              <span style={{ color }}>{line.content}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StreamContent({ stream, items }: { stream: string; items: JsonlLine[] }) {
  if (stream === "stdout") {
    const timeGroups = groupByTimeWindow(items);
    return (
      <>
        {timeGroups.map((group, gi) => (
          <div key={gi} style={{ marginBottom: "8px", borderLeft: "2px solid var(--border-color)", paddingLeft: "10px" }}>
            <div style={{ fontSize: "11px", color: "var(--accent-primary)", marginBottom: "4px", display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ background: "var(--bg-elevated)", padding: "1px 6px", borderRadius: "3px" }}>{formatTime(group.startTime)}</span>
              <span style={{ color: "var(--text-muted)" }}>{group.items.length} lines</span>
            </div>
            <ContentLines items={group.items} />
          </div>
        ))}
      </>
    );
  }
  return <ContentLines items={items} />;
}

function ContentLines({ items }: { items: JsonlLine[] }) {
  const blocks = parseDiffBlocks(items);
  return (
    <>
      {blocks.map((block, bi) => {
        if (block.type === "diff" && block.data) {
          return <DiffBlock key={bi} data={block.data as { fileName: string; lines: { type: string; content: string }[] }} />;
        }
        return (
          <div key={bi}>
            {(block.lines || []).map((item, idx) => (
              <div key={idx} style={{ display: "flex", minHeight: "18px" }}>
                <span style={{ color: "var(--text-muted)", minWidth: "40px", textAlign: "right", marginRight: "10px", fontSize: "10px" }}>{String(idx + 1).padStart(4, " ")}</span>
                <span style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "12px" }}>{item.content}</span>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

export function AgentLogView() {
  const t = useTranslation();
  const { settings } = useSettings();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(true);
  const [sessionData, setSessionData] = useState<Record<string, SessionData>>({});
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [totalLines, setTotalLines] = useState(0);
  const lastLineCount = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let closed = false;
    async function loadProjects() {
      if (settings.useMockData) {
        if (!closed) {
          setProjects(mockData.mockProjects);
          if (mockData.mockProjects.length > 0) {
            setSelectedProjectId(mockData.mockProjects[0].projectId);
          }
          setError(null);
          setLoading(false);
        }
        return;
      }

      try {
        const data = await projectApi.list();
        if (!closed) {
          setProjects(data.items ?? []);
          if ((data.items?.length ?? 0) > 0) {
            setSelectedProjectId(data.items![0].projectId);
          }
          setError(null);
        }
      } catch (err) {
        if (!closed) {
          setError(err instanceof Error ? err.message : "Failed to load projects");
        }
      } finally {
        if (!closed) setLoading(false);
      }
    }
    loadProjects();
    return () => { closed = true; };
  }, [settings.useMockData]);

  const fetchData = useCallback(async () => {
    if (!selectedProjectId || settings.useMockData) return;

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(selectedProjectId)}/codex-output?t=${Date.now()}`);
      if (!response.ok) {
        if (response.status === 404) {
          setSessionData({});
          setTotalLines(0);
          lastLineCount.current = 0;
        }
        return;
      }

      const text = await response.text();
      if (!text.trim()) {
        setTotalLines(0);
        return;
      }

      const lines = text.trim().split("\n");
      setTotalLines(lines.length);

      if (lines.length > lastLineCount.current) {
        const newLines = lines.slice(lastLineCount.current);
        processNewLines(newLines);
        lastLineCount.current = lines.length;
      }
    } catch (err) {
      console.error("Fetch error:", err);
    }
  }, [selectedProjectId, settings.useMockData]);

  function processNewLines(lines: string[]) {
    setSessionData((prev) => {
      const newData = { ...prev };

      lines.forEach((line) => {
        try {
          const obj = JSON.parse(line);
          const sessionId = obj.sessionId || "unknown";
          const stream = obj.stream || "other";
          const content = obj.content || "";
          const timestamp = obj.timestamp || "";

          if (!newData[sessionId]) {
            newData[sessionId] = {
              id: sessionId,
              role: extractRole(sessionId),
              streams: {},
              firstSeen: timestamp,
              lastSeen: timestamp
            };
          }

          if (!newData[sessionId].streams[stream]) {
            newData[sessionId].streams[stream] = [];
          }

          newData[sessionId].streams[stream].push({
            sessionId,
            stream,
            content,
            timestamp,
            timestampMs: timestamp ? new Date(timestamp).getTime() : 0
          });

          if (timestamp) {
            newData[sessionId].lastSeen = timestamp;
          }
        } catch {
          const sessionId = "parse-error";
          if (!newData[sessionId]) {
            newData[sessionId] = {
              id: sessionId,
              role: "error",
              streams: {},
              firstSeen: "",
              lastSeen: ""
            };
          }
          if (!newData[sessionId].streams.other) {
            newData[sessionId].streams.other = [];
          }
          newData[sessionId].streams.other.push({
            sessionId,
            stream: "other",
            content: line,
            timestamp: "",
            timestampMs: 0
          });
        }
      });

      return newData;
    });
  }

  useEffect(() => {
    if (!selectedProjectId) {
      setSessionData({});
      setTotalLines(0);
      lastLineCount.current = 0;
      return;
    }

    setLoadingData(true);
    setSessionData({});
    setTotalLines(0);
    lastLineCount.current = 0;

    fetchData().finally(() => setLoadingData(false));
  }, [selectedProjectId, fetchData]);

  useEffect(() => {
    if (isRunning && selectedProjectId) {
      intervalRef.current = setInterval(fetchData, REFRESH_INTERVAL);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isRunning, selectedProjectId, fetchData]);

  function toggleSession(sessionId: string) {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }

  function expandAll() {
    setExpandedSessions(new Set(Object.keys(sessionData)));
  }

  function collapseAll() {
    setExpandedSessions(new Set());
  }

  function resetAndReload() {
    lastLineCount.current = 0;
    setSessionData({});
    setTotalLines(0);
    fetchData();
  }

  const sessions = Object.values(sessionData).sort((a, b) => (a.lastSeen || "").localeCompare(b.lastSeen || ""));
  const sessionCount = Object.keys(sessionData).length;

  if (loading) {
    return (
      <section>
        <div className="page-header">
          <h1>Agent Logs</h1>
        </div>
        <div className="empty-state">
          <Loader size={24} className="loading-spinner" />
          <p>{t.loading}</p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section>
        <div className="page-header">
          <h1>Agent Logs</h1>
        </div>
        <div className="error-message">{error}</div>
      </section>
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1 style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <FileCode size={24} />
          Agent Logs
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span className="badge badge-neutral">Lines: {totalLines} | Sessions: {sessionCount}</span>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            {isRunning ? (
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent-success)", animation: "pulse 2s infinite" }} />
            ) : (
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent-warning)" }} />
            )}
            <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{isRunning ? "Running" : "Paused"}</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="form-group" style={{ marginBottom: "16px" }}>
          <label>{t.projectId}</label>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <select
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              style={{ flex: 1 }}
            >
              <option value="">-- Select a project --</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name} ({p.projectId})
                </option>
              ))}
            </select>
            {loadingData && <Loader size={16} className="loading-spinner" />}
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn btn-secondary" onClick={() => setIsRunning(!isRunning)}>
            {isRunning ? <Pause size={14} /> : <Play size={14} />}
            {isRunning ? "Pause" : "Resume"}
          </button>
          <button className="btn btn-secondary" onClick={expandAll}>Expand All</button>
          <button className="btn btn-secondary" onClick={collapseAll}>Collapse All</button>
          <button className="btn btn-secondary" onClick={resetAndReload}>
            <RotateCcw size={14} />
            Reset
          </button>
        </div>
      </div>

      {selectedProjectId && (
        <div className="card" data-scrollable style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {sessions.length === 0 ? (
              <div className="empty-state" style={{ padding: "24px" }}>
                <Bug size={32} style={{ opacity: 0.3 }} />
                <p>{t.noData}</p>
              </div>
            ) : (
              sessions.map((session) => {
                const isExpanded = expandedSessions.has(session.id);
                const sessionLines = Object.values(session.streams).reduce((sum, arr) => sum + arr.length, 0);

                return (
                  <div key={session.id} style={{ marginBottom: "16px", border: "1px solid var(--border-color)", borderRadius: "8px", overflow: "hidden" }}>
                    <div
                      onClick={() => toggleSession(session.id)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 15px",
                        background: "var(--bg-elevated)",
                        cursor: "pointer"
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <code style={{ fontSize: "13px", fontWeight: 600, color: "var(--accent-warning)" }}>{session.id}</code>
                        <span className="badge badge-primary">{session.role}</span>
                      </div>
                      <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{sessionLines} lines</span>
                    </div>

                    {isExpanded && (
                      <div style={{ padding: "10px" }}>
                        {streamOrder.map((stream) => {
                          const items = session.streams[stream];
                          if (!items || items.length === 0) return null;

                          const streamColors: Record<string, string> = {
                            stdout: "var(--accent-success)",
                            stderr: "var(--accent-danger)",
                            system: "var(--accent-primary)",
                            response: "var(--accent-warning)",
                            other: "var(--text-muted)"
                          };

                          return (
                            <div key={stream} style={{ marginBottom: "10px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "5px", paddingBottom: "3px", borderBottom: "1px solid var(--border-color)" }}>
                                <span className="badge" style={{ background: `${streamColors[stream]}20`, color: streamColors[stream], fontSize: "10px" }}>{stream.toUpperCase()}</span>
                                <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{items.length} lines</span>
                              </div>
                              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "12px", lineHeight: 1.4, maxHeight: "300px", overflowY: "auto" }}>
                                <StreamContent stream={stream} items={items} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </section>
  );
}
