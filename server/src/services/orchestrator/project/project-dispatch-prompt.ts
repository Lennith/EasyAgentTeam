import type { ManagerToAgentMessage } from "../../../domain/models.js";
import { isDiscussMessage, readMessageTypeUpper } from "../../orchestrator-dispatch-core.js";
import type { ProjectDispatchPromptContext } from "./project-dispatch-prompt-context.js";

export function buildProjectDispatchPrompt(context: ProjectDispatchPromptContext): string {
  const { frame, focusTask, messages, routingSnapshot, session } = context;
  const allowedTargets =
    routingSnapshot.allowedTargets.length > 0
      ? routingSnapshot.allowedTargets.map((item) => `${item.agentId}(max_rounds=${item.maxDiscussRounds})`).join(", ")
      : "(none)";
  const enabledAgents = routingSnapshot.enabledAgents.length > 0 ? routingSnapshot.enabledAgents.join(", ") : "(none)";
  const focusTaskId = frame.focusTaskId ?? "(none)";
  const lines: string[] = [
    `You are role=${frame.role}, session=${frame.sessionId ?? "unknown"}.`,
    `TeamWorkSpace=${frame.teamWorkspace} (shared project directory).`,
    `YourWorkspace=${frame.yourWorkspace} (your personal working directory).`,
    "",
    "Runtime mode: static team rules are in local AGENTS.md.",
    "",
    "## Routing Snapshot",
    `from_agent_enabled=${routingSnapshot.fromAgentEnabled ? "true" : "false"}`,
    `enabled_agents=${enabledAgents}`,
    `allowed_targets=${allowedTargets}`,
    "",
    "## Incoming Messages",
    `task_id: ${context.taskId ?? "(none)"}`,
    `focus_task_id: ${focusTaskId}`,
    `this_turn_operate_task_id: ${focusTaskId} (focus task first)`,
    `visible_actionable_tasks: ${frame.visibleActionableTasks.join(", ") || "(none)"}`,
    `visible_blocked_tasks: ${frame.visibleBlockedTasks.join(", ") || "(none)"}`,
    `focus_task_dependencies_ready: ${frame.dependenciesReady ? "true" : "false"}`,
    `focus_task_unresolved_dependencies: ${frame.unresolvedDependencies.join(", ") || "(none)"}`,
    `total_messages: ${messages.length}`,
    ""
  ];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    lines.push(`### Message ${index + 1} [${readMessageTypeUpper(message)}]`);
    if (isDiscussMessage(message)) {
      const sender = message.envelope.sender;
      const reportTo = message.envelope.accountability?.report_to;
      lines.push(`from: ${sender?.role ?? "unknown"}`);
      if (reportTo) {
        lines.push(`reply_to: ${reportTo.role}`);
      }
      lines.push("");
    }
    lines.push("```json");
    lines.push(JSON.stringify(message.body, null, 2));
    lines.push("```");
    lines.push("");
  }

  const discussMessages = messages.filter((message) => isDiscussMessage(message));
  if (discussMessages.length > 0) {
    lines.push("## Discuss Context");
    lines.push("");
    if (discussMessages.length === 1) {
      const discussContext = extractDiscussContext(discussMessages[0]);
      if (discussContext) {
        lines.push(`thread_id: ${discussContext.threadId}`);
        lines.push(`current_round: ${discussContext.round}`);
        lines.push(`max_rounds: ${discussContext.maxRounds}`);
        lines.push("");
        const reportTo = discussMessages[0].envelope.accountability?.report_to;
        if (reportTo) {
          lines.push(`reply_to: ${reportTo.role}`);
        }
      }
    } else {
      lines.push("Multiple discuss threads detected. Check each message for thread_id and reply accordingly.");
      lines.push("");
      for (const message of discussMessages) {
        const discussContext = extractDiscussContext(message);
        const reportTo = message.envelope.accountability?.report_to;
        if (discussContext) {
          lines.push(
            `- thread_id: ${discussContext.threadId}, round: ${discussContext.round}/${discussContext.maxRounds}, reply_to: ${reportTo?.role ?? "unknown"}`
          );
        }
      }
    }
  }

  const discussMaxRoundsMap: Record<string, number> = {};
  for (const target of routingSnapshot.allowedTargets) {
    discussMaxRoundsMap[target.agentId] = target.maxDiscussRounds;
  }
  lines.push("");
  lines.push("## Discuss Tool Usage Guide");
  lines.push("When replying to a discuss message:");
  lines.push("- Find the thread_id from the message you want to reply to");
  lines.push("- Use round = current_round + 1 for your reply");
  lines.push("When starting a new discussion with another agent:");
  lines.push(`- thread_id: Generate as \`${context.taskId ?? "task"}-\${timestamp}\` or use existing thread`);
  lines.push(`- max_rounds per target: ${JSON.stringify(discussMaxRoundsMap)}`);
  lines.push(
    "- if discuss is about task, read <YourWorkSpace>/progress.md and then use task_report_* ToolCalls when you make progress."
  );
  lines.push(
    "- discuss tool calls are `discuss_request`, `discuss_reply`, `discuss_close` (discussion only, not progress)."
  );
  lines.push(
    "- task report tool calls are `task_report_in_progress`, `task_report_done`, `task_report_block` (use these for progress/completion)."
  );
  lines.push("- focus task context:");
  lines.push(`  - title: ${focusTask?.title ?? "(none)"}`);
  lines.push("- focus task first: this turn should operate on the focus task unless you have valid side work.");
  lines.push(
    "- non-focus task reporting is allowed only when dependencies are already ready; this is non-preferred compared to focus task."
  );
  lines.push(
    "- never report IN_PROGRESS/DONE/MAY_BE_DONE for dependency-blocked tasks; wait for dependency completion signal/reminder."
  );
  lines.push(
    "- if dependency-related report is rejected, retract or downgrade conflicting premature completion claims to draft and retry later."
  );
  return lines.join("\n");
}

export function extractDiscussContext(
  message: ManagerToAgentMessage
): { threadId: string; round: number; maxRounds: number } | null {
  const body = message.body as Record<string, unknown>;
  const discuss = body.discuss as Record<string, unknown> | undefined;
  if (!discuss) {
    const threadId = body.thread_id ?? body.threadId;
    if (threadId && typeof threadId === "string") {
      return {
        threadId,
        round: (body.round as number) ?? 1,
        maxRounds: (body.max_rounds as number) ?? (body.maxRounds as number) ?? 3
      };
    }
    return null;
  }
  const threadId = discuss.thread_id ?? discuss.threadId;
  if (!threadId || typeof threadId !== "string") {
    return null;
  }
  return {
    threadId,
    round: (discuss.round as number) ?? 1,
    maxRounds: (discuss.max_rounds as number) ?? (discuss.maxRounds as number) ?? 3
  };
}
