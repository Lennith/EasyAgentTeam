import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "@/hooks/i18n";
import type { SessionRecord } from "@/types";
import { Send, XCircle, Loader, MessageCircle, Clock, Bot } from "lucide-react";

interface AgentChatViewProps {
  projectId: string;
  sessions: SessionRecord[];
}

const API_BASE = "/api";

interface ChatMessage {
  type: "thinking" | "tool_call" | "tool_result" | "message" | "complete" | "error" | "step";
  content: string;
  timestamp: number;
  role?: "user" | "assistant";
}

export function AgentChatView({ projectId, sessions }: AgentChatViewProps) {
  const t = useTranslation();
  const [selectedSession, setSelectedSession] = useState<SessionRecord | null>(null);
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

  // Group sessions by role
  const sessionsByRole = useMemo(() => {
    const grouped: Record<string, SessionRecord[]> = {};
    for (const session of sessions) {
      if (!session.role) continue;
      if (!grouped[session.role]) {
        grouped[session.role] = [];
      }
      grouped[session.role].push(session);
    }
    return grouped;
  }, [sessions]);

  const agentRoles = Object.keys(sessionsByRole);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    if (!selectedSession || !inputText.trim()) return;

    // Save user's input before clearing
    const prompt = inputText.trim();

    // Reset state and show user message immediately
    setMessages([{
      type: "message",
      content: prompt,
      timestamp: Date.now(),
      role: "user"
    }]);
    setError(null);
    setLoading(true);
    setCurrentStep(null);
    setMaxSteps(0);
    setFinishReason(null);
    setActiveSessionId(null);

    setInputText("");
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}/agent-chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            role: selectedSession.role, 
            prompt,
            sessionId: selectedSession.sessionId,
            providerSessionId: selectedSession.providerSessionId
          }),
          signal: abortControllerRef.current.signal,
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || `HTTP ${response.status}`);
      }

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

        // Parse SSE events - properly handle event: and data: pairs
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:") && currentEvent) {
            const dataStr = line.slice(5).trim();
            if (!dataStr) continue;

            try {
              const data = JSON.parse(dataStr);
              handleStreamEvent(currentEvent, data);
            } catch {
              // Skip invalid JSON
            }
            currentEvent = "";
          } else if (line.startsWith("data:")) {
            // No event prefix, treat as default
            const dataStr = line.slice(5).trim();
            if (!dataStr) continue;

            try {
              const data = JSON.parse(dataStr);
              handleStreamEvent("message", data);
            } catch {
              // Skip invalid JSON
            }
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

  function handleStreamEvent(eventType: string, eventData: Record<string, unknown>) {
    const type = eventType;
    const data = eventData;

    switch (type) {
      case "session": {
        const sessionId = data?.sessionId as string | undefined;
        if (sessionId) setActiveSessionId(sessionId);
        break;
      }
      case "thinking": {
        const thinkingData = data as { thinking?: string } | undefined;
        const thinking = thinkingData?.thinking;
        if (thinking) {
          setMessages((prev) => [
            ...prev,
            {
              type: "thinking" as const,
              content: thinking,
              timestamp: Date.now(),
            },
          ]);
        }
        break;
      }
      case "tool_call": {
        const toolData = data as { name?: string; args?: Record<string, unknown> } | undefined;
        if (toolData?.name) {
          setMessages((prev) => [
            ...prev,
            {
              type: "tool_call",
              content: `🔧 Calling tool: ${toolData.name}${
                toolData.args ? `\n${JSON.stringify(toolData.args, null, 2)}` : ""
              }`,
              timestamp: Date.now(),
            },
          ]);
        }
        break;
      }
      case "tool_result": {
        const resultData = data as { name?: string; result?: { content?: string; error?: string; success?: boolean } } | undefined;
        if (resultData?.name && resultData?.result) {
          const resultContent = resultData.result.error
            ? `❌ Error: ${resultData.result.error}`
            : resultData.result.content || "OK";
          setMessages((prev) => [
            ...prev,
            {
              type: "tool_result",
              content: `📝 ${resultData.name} result:\n${resultContent}`,
              timestamp: Date.now(),
            },
          ]);
        }
        break;
      }
      case "step": {
        const stepData = data as { step?: number; maxSteps?: number } | undefined;
        if (stepData?.step !== undefined) {
          setCurrentStep(stepData.step);
          setMaxSteps(stepData.maxSteps || 0);
        }
        break;
      }
      case "message": {
        const msgData = data as { role?: string; content?: string } | undefined;
        const content = msgData?.content;
        if (content) {
          setMessages((prev) => [
            ...prev,
            {
              type: "message" as const,
              content: content,
              timestamp: Date.now(),
            },
          ]);
        }
        break;
      }
      case "complete": {
        const completeData = data as { result?: string; finishReason?: string } | undefined;
        const finishReason = completeData?.finishReason;
        const result = completeData?.result;
        if (finishReason) {
          setFinishReason(finishReason);
        }
        if (result) {
          setMessages((prev) => [
            ...prev,
            {
              type: "complete" as const,
              content: result,
              timestamp: Date.now(),
            },
          ]);
        }
        break;
      }
      case "error": {
        const errorData = data as { message?: string } | undefined;
        if (errorData?.message) {
          setError(errorData.message);
        }
        break;
      }
    }
  }

  async function handleInterrupt() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    if (activeSessionId) {
      try {
        await fetch(
          `${API_BASE}/projects/${encodeURIComponent(projectId)}/agent-chat/${encodeURIComponent(activeSessionId)}/interrupt`,
          { method: "POST" }
        );
      } catch {
        // Ignore interrupt errors
      }
    }

    setActiveSessionId(null);
    setLoading(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <section>
      <div className="page-header">
        <h1>{t.agentChat || "Agent Chat"}</h1>
      </div>

      <div style={{ display: "flex", gap: "16px", height: "calc(100vh - 180px)" }}>
        {/* Left sidebar: Agent list */}
        <div
          style={{
            width: "240px",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: "8px",
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
                    <div style={{ 
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontWeight: 600, 
                      fontSize: "12px", 
                      color: "var(--text-muted)",
                      marginBottom: "4px",
                      marginTop: "12px"
                    }}>
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
                          background: selectedSession?.sessionId === session.sessionId 
                            ? "var(--accent-primary)20" 
                            : "var(--bg-surface)",
                          borderRadius: "6px",
                          cursor: "pointer",
                          border: `1px solid ${selectedSession?.sessionId === session.sessionId ? "var(--accent-primary)" : "transparent"}`,
                          transition: "all 0.15s ease",
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
                          <div style={{ fontWeight: 500, fontSize: "13px", display: "flex", alignItems: "center", gap: "6px" }}>
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

        {/* Right panel: Chat area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Messages area */}
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
                      }`,
                    }}
                  >
                    <div
                      style={{
                        fontSize: "11px",
                        color: "var(--text-muted)",
                        marginBottom: "4px",
                        textTransform: "uppercase",
                      }}
                    >
                      {msg.role === "user"
                        ? "👤 You"
                        : msg.type === "thinking"
                        ? "🤔 Thinking"
                        : msg.type === "tool_call"
                        ? "🔧 Tool Call"
                        : msg.type === "tool_result"
                        ? "📝 Tool Result"
                        : msg.type === "message"
                        ? "💬 Message"
                        : msg.type === "complete"
                        ? "✅ Complete"
                        : msg.type}
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontSize: "13px",
                        fontFamily: "inherit",
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
                      gap: "8px",
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
                      color: "var(--accent-success)",
                    }}
                  >
                    🎯 Finish Reason: {finishReason}
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

          {/* Input area */}
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
                  resize: "vertical",
                }}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <button
                  className="btn btn-primary"
                  onClick={handleSend}
                  disabled={!selectedSession || !inputText.trim() || loading}
                >
                  {loading ? <Loader size={14} className="loading-spinner" /> : <Send size={14} />}
                  <span style={{ marginLeft: "6px" }}>{t.send || "Send"}</span>
                </button>
                {loading && (
                  <button className="btn btn-danger" onClick={handleInterrupt}>
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
