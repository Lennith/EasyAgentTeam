import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "@/hooks/i18n";
import { agentChatApi } from "@/services/api";
import type { SessionRecord, WorkflowSessionRecord } from "@/types";
import { Send, XCircle, Loader, MessageCircle, Clock, Bot } from "lucide-react";

interface AgentChatViewProps {
  projectId?: string;
  runId?: string;
  sessions: Array<SessionRecord | WorkflowSessionRecord>;
}

type SessionLite = {
  sessionId: string;
  role: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  lastActiveAt?: string;
  providerSessionId?: string | null;
};

interface ChatMessage {
  type: "thinking" | "tool_call" | "tool_result" | "message" | "complete" | "error" | "step";
  content: string;
  timestamp: number;
  role?: "user" | "assistant";
}

function parseMs(value?: string): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionStatusWeight(status?: string): number {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "running") return 0;
  if (normalized === "idle") return 1;
  if (normalized === "blocked") return 2;
  if (normalized === "dismissed") return 99;
  return 10;
}

function pickAuthoritativeSession(candidates: SessionLite[]): SessionLite | null {
  const available = candidates.filter((item) => sessionStatusWeight(item.status) < 99);
  if (available.length === 0) {
    return null;
  }
  const sorted = [...available].sort((a, b) => {
    const aWeight = sessionStatusWeight(a.status);
    const bWeight = sessionStatusWeight(b.status);
    if (aWeight !== bWeight) {
      return aWeight - bWeight;
    }
    const aRecent = Math.max(parseMs(a.lastActiveAt), parseMs(a.updatedAt), parseMs(a.createdAt));
    const bRecent = Math.max(parseMs(b.lastActiveAt), parseMs(b.updatedAt), parseMs(b.createdAt));
    if (aRecent !== bRecent) {
      return bRecent - aRecent;
    }
    return a.sessionId.localeCompare(b.sessionId);
  });
  return sorted[0] ?? null;
}

export function AgentChatView({ projectId, runId, sessions }: AgentChatViewProps) {
  const t = useTranslation();
  const [selectedSession, setSelectedSession] = useState<SessionLite | null>(null);
  const [inputText, setInputText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<number | null>(null);
  const [maxSteps, setMaxSteps] = useState<number>(0);
  const [finishReason, setFinishReason] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatScope = useMemo(() => {
    if (projectId) {
      return { projectId } as const;
    }
    if (runId) {
      return { runId } as const;
    }
    return null;
  }, [projectId, runId]);

  const sessionItems = useMemo<SessionLite[]>(() => {
    const normalized = sessions
      .filter((item) => Boolean(item.sessionId) && Boolean(item.role))
      .map((item) => ({
        sessionId: item.sessionId,
        role: item.role,
        status: item.status,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        lastActiveAt: item.lastActiveAt,
        providerSessionId: typeof item.providerSessionId === "string" ? item.providerSessionId : null
      }));
    const byRole = new Map<string, SessionLite[]>();
    for (const item of normalized) {
      const bucket = byRole.get(item.role) ?? [];
      bucket.push(item);
      byRole.set(item.role, bucket);
    }
    const authoritative: SessionLite[] = [];
    for (const [, roleSessions] of byRole.entries()) {
      const winner = pickAuthoritativeSession(roleSessions);
      if (winner) {
        authoritative.push(winner);
      }
    }
    return authoritative.sort((a, b) => a.role.localeCompare(b.role));
  }, [sessions]);

  const sessionsByRole = useMemo(() => {
    const grouped: Record<string, SessionLite[]> = {};
    for (const session of sessionItems) {
      if (!grouped[session.role]) {
        grouped[session.role] = [];
      }
      grouped[session.role].push(session);
    }
    return grouped;
  }, [sessionItems]);

  const agentRoles = Object.keys(sessionsByRole);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }
    const stillExists = sessionItems.some((item) => item.sessionId === selectedSession.sessionId);
    if (!stillExists) {
      setSelectedSession(null);
      setMessages([]);
      setError(null);
      setActiveSessionId(null);
      setFinishReason(null);
    }
  }, [sessionItems, selectedSession]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    if (!selectedSession || !inputText.trim()) return;
    if (!chatScope) {
      setError("Missing chat scope: projectId or runId is required");
      return;
    }

    const prompt = inputText.trim();
    setMessages([
      {
        type: "message",
        content: prompt,
        timestamp: Date.now(),
        role: "user"
      }
    ]);
    setError(null);
    setLoading(true);
    setCurrentStep(null);
    setMaxSteps(0);
    setFinishReason(null);
    setActiveSessionId(null);
    setInputText("");
    abortControllerRef.current = new AbortController();

    try {
      const response = await agentChatApi.stream(
        chatScope,
        {
          role: selectedSession.role,
          prompt,
          sessionId: selectedSession.sessionId,
          providerSessionId: selectedSession.providerSessionId
        },
        abortControllerRef.current.signal
      );

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const dataStr = line.slice(5).trim();
            if (!dataStr) continue;
            try {
              const data = JSON.parse(dataStr);
              handleStreamEvent(currentEvent || "message", data as Record<string, unknown>);
            } catch {
              // ignore malformed chunk
            }
            currentEvent = "";
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setError("Request cancelled");
      } else {
        setError(err instanceof Error ? err.message : "Request failed");
      }
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
  }

  function handleStreamEvent(eventType: string, data: Record<string, unknown>) {
    switch (eventType) {
      case "session": {
        const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
        if (sessionId) setActiveSessionId(sessionId);
        break;
      }
      case "thinking": {
        const thinking = typeof data.thinking === "string" ? data.thinking : undefined;
        if (thinking) {
          setMessages((prev) => [...prev, { type: "thinking", content: thinking, timestamp: Date.now() }]);
        }
        break;
      }
      case "tool_call": {
        const name = typeof data.name === "string" ? data.name : undefined;
        const args = typeof data.args === "object" && data.args !== null ? data.args : undefined;
        if (name) {
          setMessages((prev) => [
            ...prev,
            {
              type: "tool_call",
              content: `Calling tool: ${name}${args ? `\n${JSON.stringify(args, null, 2)}` : ""}`,
              timestamp: Date.now()
            }
          ]);
        }
        break;
      }
      case "tool_result": {
        const name = typeof data.name === "string" ? data.name : undefined;
        const result = typeof data.result === "object" && data.result !== null ? data.result : undefined;
        if (name && result) {
          const resultObj = result as { content?: string; error?: string };
          const resultContent = resultObj.error ? `Error: ${resultObj.error}` : resultObj.content || "OK";
          setMessages((prev) => [
            ...prev,
            {
              type: "tool_result",
              content: `${name} result:\n${resultContent}`,
              timestamp: Date.now()
            }
          ]);
        }
        break;
      }
      case "step": {
        const step = typeof data.step === "number" ? data.step : undefined;
        const max = typeof data.maxSteps === "number" ? data.maxSteps : undefined;
        if (step !== undefined) {
          setCurrentStep(step);
          setMaxSteps(max ?? 0);
        }
        break;
      }
      case "message": {
        const content = typeof data.content === "string" ? data.content : undefined;
        if (content) {
          setMessages((prev) => [...prev, { type: "message", content, timestamp: Date.now() }]);
        }
        break;
      }
      case "complete": {
        const result = typeof data.result === "string" ? data.result : undefined;
        const reason = typeof data.finishReason === "string" ? data.finishReason : undefined;
        if (reason) {
          setFinishReason(reason);
        }
        if (result) {
          setMessages((prev) => [...prev, { type: "complete", content: result, timestamp: Date.now() }]);
        }
        break;
      }
      case "error": {
        const message = typeof data.message === "string" ? data.message : undefined;
        if (message) {
          setError(message);
        }
        break;
      }
      default:
        break;
    }
  }

  async function handleInterrupt() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    if (activeSessionId && chatScope) {
      try {
        await agentChatApi.interrupt(chatScope, activeSessionId);
      } catch {
        // ignore interrupt errors
      }
    }

    setActiveSessionId(null);
    setLoading(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <section>
      <div className="page-header">
        <h1>{t.agentChat || "Agent Chat"}</h1>
      </div>

      <div style={{ display: "flex", gap: "16px", height: "calc(100vh - 180px)" }}>
        <div
          style={{
            width: "240px",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: "8px"
          }}
        >
          <div className="card" style={{ flex: 1, overflow: "auto" }}>
            <div className="card-header">
              <h3>{t.availableAgents || "Available Agents"}</h3>
            </div>

            {agentRoles.length === 0 ? (
              <div className="empty-state" style={{ padding: "16px" }}>
                <p>{t.noData}</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {agentRoles.map((role) => (
                  <div key={role}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        fontWeight: 600,
                        fontSize: "12px",
                        color: "var(--text-muted)",
                        marginBottom: "4px",
                        marginTop: "12px"
                      }}
                    >
                      <Bot size={12} />
                      {role}
                    </div>
                    {sessionsByRole[role].map((session) => (
                      <div
                        key={session.sessionId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          padding: "10px 12px",
                          marginLeft: "8px",
                          background:
                            selectedSession?.sessionId === session.sessionId
                              ? "var(--accent-primary)20"
                              : "var(--bg-surface)",
                          borderRadius: "6px",
                          cursor: "pointer",
                          border: `1px solid ${selectedSession?.sessionId === session.sessionId ? "var(--accent-primary)" : "transparent"}`,
                          transition: "all 0.15s ease"
                        }}
                        onClick={() => {
                          setSelectedSession(session);
                          setMessages([]);
                          setError(null);
                          setActiveSessionId(null);
                          setFinishReason(null);
                        }}
                      >
                        <MessageCircle size={16} style={{ color: "var(--accent-primary)", flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontWeight: 500,
                              fontSize: "13px",
                              display: "flex",
                              alignItems: "center",
                              gap: "6px"
                            }}
                          >
                            Chat
                            {session.lastActiveAt && (
                              <span style={{ fontSize: "10px", color: "var(--text-muted)", fontWeight: 400 }}>
                                <Clock size={10} style={{ marginRight: 2, verticalAlign: "middle" }} />
                                {new Date(session.lastActiveAt).toLocaleTimeString()}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "16px" }}>
          <div className="card" style={{ flex: 1, overflow: "auto" }}>
            <div className="card-header">
              <h3>{t.chat || "Chat"}</h3>
              {currentStep !== null && maxSteps > 0 && (
                <span style={{ fontSize: "12px", color: "var(--text-muted)", marginLeft: "8px" }}>
                  Step {currentStep}/{maxSteps}
                </span>
              )}
            </div>

            {!selectedSession ? (
              <div className="empty-state" style={{ padding: "24px" }}>
                <p>{t.selectAgent || "Select an agent to start chatting"}</p>
              </div>
            ) : messages.length === 0 && !loading ? (
              <div className="empty-state" style={{ padding: "24px" }}>
                <p>{t.enterPrompt || "Enter a prompt to send to the agent"}</p>
              </div>
            ) : (
              <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
                {messages.map((msg, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: "12px",
                      background:
                        msg.role === "user"
                          ? "var(--accent-primary)10"
                          : msg.type === "thinking"
                            ? "var(--accent-primary)10"
                            : msg.type === "tool_call"
                              ? "var(--accent-warning)10"
                              : msg.type === "tool_result"
                                ? "var(--accent-success)10"
                                : msg.type === "error"
                                  ? "var(--accent-danger)10"
                                  : msg.type === "complete"
                                    ? "var(--bg-surface)"
                                    : "var(--bg-elevated)",
                      borderRadius: "8px",
                      borderLeft: `3px solid ${
                        msg.role === "user"
                          ? "var(--accent-primary)"
                          : msg.type === "thinking"
                            ? "var(--accent-primary)"
                            : msg.type === "tool_call"
                              ? "var(--accent-warning)"
                              : msg.type === "tool_result"
                                ? "var(--accent-success)"
                                : msg.type === "error"
                                  ? "var(--accent-danger)"
                                  : msg.type === "complete"
                                    ? "var(--accent-success)"
                                    : "var(--border-color)"
                      }`
                    }}
                  >
                    <div
                      style={{
                        fontSize: "11px",
                        color: "var(--text-muted)",
                        marginBottom: "4px",
                        textTransform: "uppercase"
                      }}
                    >
                      {msg.role === "user"
                        ? "You"
                        : msg.type === "thinking"
                          ? "Thinking"
                          : msg.type === "tool_call"
                            ? "Tool Call"
                            : msg.type === "tool_result"
                              ? "Tool Result"
                              : msg.type === "message"
                                ? "Message"
                                : msg.type === "complete"
                                  ? "Complete"
                                  : msg.type}
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontSize: "13px",
                        fontFamily: "inherit"
                      }}
                    >
                      {msg.content}
                    </pre>
                  </div>
                ))}
                {loading && (
                  <div
                    style={{
                      padding: "12px",
                      background: "var(--bg-elevated)",
                      borderRadius: "8px",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px"
                    }}
                  >
                    <Loader size={14} className="loading-spinner" />
                    <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                      {currentStep !== null
                        ? `Running... Step ${currentStep}${maxSteps > 0 ? `/${maxSteps}` : ""}`
                        : "Starting..."}
                    </span>
                  </div>
                )}
                {finishReason && (
                  <div
                    style={{
                      padding: "12px",
                      background: "var(--accent-success)10",
                      borderRadius: "8px",
                      fontSize: "12px",
                      color: "var(--accent-success)"
                    }}
                  >
                    Finish Reason: {finishReason}
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}

            {error && (
              <div className="error-message" style={{ marginTop: "16px" }}>
                {error}
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ display: "flex", gap: "12px", alignItems: "flex-end" }}>
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t.enterPrompt || "Enter prompt..."}
                disabled={!selectedSession || loading}
                style={{
                  flex: 1,
                  minHeight: "80px",
                  resize: "vertical"
                }}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <button
                  className="btn btn-primary"
                  onClick={() => void handleSend()}
                  disabled={!selectedSession || !inputText.trim() || loading}
                >
                  {loading ? <Loader size={14} className="loading-spinner" /> : <Send size={14} />}
                  <span style={{ marginLeft: "6px" }}>{t.send || "Send"}</span>
                </button>
                {loading && (
                  <button className="btn btn-danger" onClick={() => void handleInterrupt()}>
                    <XCircle size={14} />
                    <span style={{ marginLeft: "6px" }}>{t.interrupt || "Interrupt"}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
