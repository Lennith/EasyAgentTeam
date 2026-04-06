import type {
  ManagerToAgentMessage,
  ReminderMode,
  ReminderTaskPayload,
  RoleRuntimeState,
  WorkflowManagerToAgentMessage
} from "../../../domain/models.js";
import { buildReminderMessageBody } from "../../reminder-message-builder.js";
import {
  calculateNextReminderTimeByMode,
  evaluateReminderEligibility,
  shouldAutoResetReminderOnRoleTransition,
  type ReminderEligibilityInput
} from "../project/project-reminder-policy.js";
import { buildOrchestratorMessageEnvelope } from "./manager-message-contract.js";

export interface OrchestratorReminderTimingOptions {
  initialWaitMs: number;
  backoffMultiplier: number;
  maxWaitMs: number;
}

export interface BuildOrchestratorReminderRoleStatePatchInput {
  previousRoleState: RoleRuntimeState;
  currentRoleState: RoleRuntimeState;
  reminderMode: ReminderMode;
  reminderCount: number;
  nowMs: number;
  idleSince?: string;
  timing: OrchestratorReminderTimingOptions;
}

export interface BuildOrchestratorReminderSchedulePatchInput {
  reminderMode: ReminderMode;
  reminderCount: number;
  nowMs: number;
  timing: OrchestratorReminderTimingOptions;
}

export interface OrchestratorReminderRoleStatePatch {
  reminderCount?: number;
  idleSince?: string;
  nextReminderAt?: string;
  lastRoleState: RoleRuntimeState;
}

export interface OrchestratorReminderOpenTaskSummaryInputItem {
  taskId: string;
  title: string;
}

export interface OrchestratorReminderOpenTaskSummary {
  openTaskIds: string[];
  openTaskTitles: Array<{ task_id: string; title: string }>;
  openTaskTitlePreview: string;
}

export interface OrchestratorReminderStateLike {
  idleSince?: string;
  reminderCount: number;
  nextReminderAt?: string;
  lastRoleState?: RoleRuntimeState;
}

export interface OrchestratorReminderRoleDescriptor<TSession, TOpenTask> {
  currentRoleState: RoleRuntimeState;
  idleSession: TSession | null;
  sessionIdleSince?: string;
  openTasks: TOpenTask[];
}

export interface OrchestratorReminderTriggerArgs<
  TReminderState extends OrchestratorReminderStateLike,
  TSession,
  TOpenTask
> {
  role: string;
  reminderMode: ReminderMode;
  reminderState: TReminderState;
  idleSession: TSession;
  openTasks: TOpenTask[];
}

export interface RunOrchestratorReminderLoopInput<
  TReminderState extends OrchestratorReminderStateLike,
  TSession,
  TOpenTask
> {
  roles: Iterable<string>;
  reminderMode: ReminderMode;
  maxRetries: number;
  nowMs: number;
  timing: OrchestratorReminderTimingOptions;
  describeRole(role: string): Promise<OrchestratorReminderRoleDescriptor<TSession, TOpenTask>>;
  getReminderState(role: string): Promise<TReminderState | null>;
  initializeReminderState(
    role: string,
    initial: Pick<OrchestratorReminderStateLike, "idleSince" | "reminderCount" | "lastRoleState">
  ): Promise<TReminderState>;
  updateReminderState(role: string, patch: Partial<OrchestratorReminderStateLike>): Promise<TReminderState>;
  triggerReminder(input: OrchestratorReminderTriggerArgs<TReminderState, TSession, TOpenTask>): Promise<void>;
}

export interface BuildOrchestratorReminderMessageInput {
  scopeKind: "project" | "workflow";
  scopeId: string;
  role: string;
  reminderMode: ReminderMode;
  reminderCount: number;
  nextReminderAt: string | null | undefined;
  openTasks: OrchestratorReminderOpenTaskSummaryInputItem[];
  content: string;
  requestId: string;
  messageId: string;
  createdAt?: string;
  primaryTaskId?: string | null;
  primarySummary?: string | null;
  primaryTask?: ReminderTaskPayload | null;
  parentRequestId?: string | null;
  intent?: string;
}

function calculateNextReminderAt(input: BuildOrchestratorReminderSchedulePatchInput): string {
  return calculateNextReminderTimeByMode(input.reminderMode, input.reminderCount, input.nowMs, {
    initialWaitMs: input.timing.initialWaitMs,
    backoffMultiplier: input.timing.backoffMultiplier,
    maxWaitMs: input.timing.maxWaitMs
  });
}

export function buildOrchestratorReminderRoleStatePatch(
  input: BuildOrchestratorReminderRoleStatePatchInput
): OrchestratorReminderRoleStatePatch {
  if (shouldAutoResetReminderOnRoleTransition(input.previousRoleState, input.currentRoleState)) {
    return {
      reminderCount: 0,
      nextReminderAt: calculateNextReminderAt({
        reminderMode: input.reminderMode,
        reminderCount: 0,
        nowMs: input.nowMs,
        timing: input.timing
      }),
      idleSince: input.idleSince,
      lastRoleState: "IDLE"
    };
  }

  if (input.previousRoleState !== "IDLE" && input.currentRoleState === "IDLE") {
    return {
      idleSince: input.idleSince,
      nextReminderAt: calculateNextReminderAt({
        reminderMode: input.reminderMode,
        reminderCount: input.reminderCount,
        nowMs: input.nowMs,
        timing: input.timing
      }),
      lastRoleState: "IDLE"
    };
  }

  if (input.currentRoleState !== "IDLE") {
    return {
      lastRoleState: input.currentRoleState
    };
  }

  return {
    lastRoleState: "IDLE"
  };
}

export function buildOrchestratorReminderSchedulePatch(
  input: BuildOrchestratorReminderSchedulePatchInput
): OrchestratorReminderRoleStatePatch {
  return {
    nextReminderAt: calculateNextReminderAt(input),
    lastRoleState: "IDLE"
  };
}

export function buildOrchestratorReminderTriggeredPatch(
  input: BuildOrchestratorReminderSchedulePatchInput
): OrchestratorReminderRoleStatePatch {
  return {
    reminderCount: input.reminderCount + 1,
    nextReminderAt: calculateNextReminderAt(input),
    lastRoleState: "IDLE"
  };
}

export function buildOrchestratorReminderOpenTaskSummary(
  openTasks: OrchestratorReminderOpenTaskSummaryInputItem[],
  previewLimit = 3
): OrchestratorReminderOpenTaskSummary {
  return {
    openTaskIds: openTasks.map((task) => task.taskId),
    openTaskTitles: openTasks.map((task) => ({
      task_id: task.taskId,
      title: task.title
    })),
    openTaskTitlePreview: openTasks
      .slice(0, previewLimit)
      .map((task) => `${task.taskId}: ${task.title}`)
      .join("; ")
  };
}

export function buildOrchestratorReminderContent(input: {
  openTaskCount: number;
  openTaskTitlePreview: string;
  instruction: string;
}): string {
  const openTaskPrefix = input.openTaskTitlePreview.length > 0 ? `Open tasks: ${input.openTaskTitlePreview}. ` : "";
  return (
    `Reminder: you have ${input.openTaskCount} open task(s) without recent progress. ` +
    openTaskPrefix +
    input.instruction
  );
}

export function buildOrchestratorReminderMessage(
  input: BuildOrchestratorReminderMessageInput & { scopeKind: "project" }
): ManagerToAgentMessage;
export function buildOrchestratorReminderMessage(
  input: BuildOrchestratorReminderMessageInput & { scopeKind: "workflow" }
): WorkflowManagerToAgentMessage;
export function buildOrchestratorReminderMessage(
  input: BuildOrchestratorReminderMessageInput
): ManagerToAgentMessage | WorkflowManagerToAgentMessage;
export function buildOrchestratorReminderMessage(
  input: BuildOrchestratorReminderMessageInput
): ManagerToAgentMessage | WorkflowManagerToAgentMessage {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const primaryTaskId = input.primaryTaskId ?? null;
  const parentRequestId = input.parentRequestId ?? (input.scopeKind === "workflow" ? input.requestId : undefined);
  const intent = input.intent ?? (input.scopeKind === "workflow" ? "MANAGER_MESSAGE" : "SYSTEM_NOTICE");
  const body = buildReminderMessageBody({
    role: input.role,
    reminderMode: input.reminderMode,
    reminderCount: input.reminderCount,
    nextReminderAt: input.nextReminderAt,
    openTasks: input.openTasks,
    content: input.content,
    primaryTaskId,
    primarySummary: input.primarySummary,
    primaryTask: input.primaryTask
  });

  if (input.scopeKind === "project") {
    return {
      envelope: buildOrchestratorMessageEnvelope({
        scopeKind: "project",
        scopeId: input.scopeId,
        messageId: input.messageId,
        createdAt,
        senderType: "system",
        senderRole: "manager",
        senderSessionId: "manager-system",
        intent,
        requestId: input.requestId,
        parentRequestId,
        taskId: primaryTaskId ?? undefined,
        ownerRole: input.role,
        reportToRole: "manager",
        reportToSessionId: "manager-system",
        expect: "TASK_REPORT",
        dispatchPolicy: "fixed_session"
      }),
      body
    };
  }

  return {
    envelope: buildOrchestratorMessageEnvelope({
      scopeKind: "workflow",
      scopeId: input.scopeId,
      messageId: input.messageId,
      createdAt,
      senderType: "system",
      senderRole: "manager",
      senderSessionId: "manager-system",
      intent,
      requestId: input.requestId,
      parentRequestId,
      taskId: primaryTaskId ?? undefined,
      ownerRole: input.role,
      reportToRole: "manager",
      reportToSessionId: "manager-system",
      expect: "TASK_REPORT",
      dispatchPolicy: "fixed_session"
    }),
    body
  };
}

export type OrchestratorReminderEligibilityInput = ReminderEligibilityInput;

export function evaluateOrchestratorReminderEligibility(
  input: OrchestratorReminderEligibilityInput
): ReturnType<typeof evaluateReminderEligibility> {
  return evaluateReminderEligibility(input);
}

export async function runOrchestratorReminderLoop<
  TReminderState extends OrchestratorReminderStateLike,
  TSession,
  TOpenTask
>(input: RunOrchestratorReminderLoopInput<TReminderState, TSession, TOpenTask>): Promise<void> {
  for (const role of input.roles) {
    const descriptor = await input.describeRole(role);
    let reminderState = await input.getReminderState(role);
    if (!reminderState) {
      reminderState = await input.initializeReminderState(role, {
        idleSince: descriptor.sessionIdleSince,
        reminderCount: 0,
        lastRoleState: descriptor.currentRoleState
      });
    }

    reminderState = await input.updateReminderState(
      role,
      buildOrchestratorReminderRoleStatePatch({
        previousRoleState: reminderState.lastRoleState ?? "INACTIVE",
        currentRoleState: descriptor.currentRoleState,
        reminderMode: input.reminderMode,
        reminderCount: reminderState.reminderCount,
        nowMs: input.nowMs,
        idleSince: descriptor.sessionIdleSince,
        timing: input.timing
      })
    );

    const eligibility = evaluateOrchestratorReminderEligibility({
      currentRoleState: descriptor.currentRoleState,
      hasIdleSession: Boolean(descriptor.idleSession),
      hasOpenTask: descriptor.openTasks.length > 0,
      reminderCount: reminderState.reminderCount,
      maxRetries: input.maxRetries,
      idleSince: reminderState.idleSince,
      nextReminderAt: reminderState.nextReminderAt,
      nowMs: input.nowMs
    });

    if (eligibility.reason === "skip_no_open_task") {
      await input.updateReminderState(role, {
        reminderCount: 0,
        nextReminderAt: undefined,
        lastRoleState: "IDLE"
      });
      continue;
    }
    if (eligibility.reason === "schedule_missing_next_reminder") {
      await input.updateReminderState(
        role,
        buildOrchestratorReminderSchedulePatch({
          reminderMode: input.reminderMode,
          reminderCount: reminderState.reminderCount,
          nowMs: input.nowMs,
          timing: input.timing
        })
      );
      continue;
    }
    if (!eligibility.eligible || !descriptor.idleSession) {
      continue;
    }

    reminderState = await input.updateReminderState(
      role,
      buildOrchestratorReminderTriggeredPatch({
        reminderMode: input.reminderMode,
        reminderCount: reminderState.reminderCount,
        nowMs: input.nowMs,
        timing: input.timing
      })
    );

    await input.triggerReminder({
      role,
      reminderMode: input.reminderMode,
      reminderState,
      idleSession: descriptor.idleSession,
      openTasks: descriptor.openTasks
    });
  }
}
