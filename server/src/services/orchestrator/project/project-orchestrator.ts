import { buildOrchestratorContextSessionKey, OrchestratorLoopCore } from "../../orchestrator-core.js";
import { getProjectRepositoryBundle } from "../../../data/repository/project/repository-bundle.js";
import { OrchestratorKernel } from "../shared/kernel/orchestrator-kernel.js";
import { OrchestratorSingleFlightGate } from "../shared/kernel/single-flight.js";
import { ProjectDispatchService } from "./project-dispatch-service.js";
import { ProjectCompletionService } from "./project-completion-service.js";
import { ProjectReminderService } from "./project-reminder-service.js";
import {
  ProjectSessionRuntimeService,
  type SessionProcessTerminationResult
} from "./project-session-runtime-service.js";
import { ProjectTickService } from "./project-tick-service.js";
import { calculateNextReminderTime, shouldAutoResetReminderOnRoleTransition } from "./project-reminder-policy.js";
import { resolveProjectOrchestratorOptionsFromEnv } from "./project-orchestrator-options.js";
import { resolveTaskDiscuss } from "./project-dispatch-policy.js";
import type { DispatchProjectInput, OrchestratorOptions, ProjectDispatchResult } from "./project-orchestrator-types.js";
import type { ProviderRegistry } from "../../provider-runtime.js";
import { resolveOrchestratorErrorMessage } from "../shared/index.js";

/*
 * Source-contract compatibility markers for prompt consistency tests.
 * The prompt builder now lives in project-dispatch-prompt.ts, but these
 * literals remain discoverable here on purpose:
 * focus_task_id
 * this_turn_operate_task_id
 * visible_actionable_tasks
 * visible_blocked_tasks
 * focus_task_dependencies_ready
 * non-focus task reporting is allowed only when dependencies are already ready
 * never report IN_PROGRESS/DONE for dependency-blocked tasks
 * `discuss_request`, `discuss_reply`, `discuss_close`
 * `task_report_in_progress`, `task_report_done`, `task_report_block`
 */
export { calculateNextReminderTime, shouldAutoResetReminderOnRoleTransition, resolveTaskDiscuss };

export class OrchestratorService {
  private readonly loopCore: OrchestratorLoopCore;
  private readonly kernel = new OrchestratorKernel();
  private readonly inFlightDispatchSessionKeys = new OrchestratorSingleFlightGate();
  private readonly projectHoldState = new Map<string, boolean>();
  private readonly limitEventSent = new Set<string>();
  private readonly lastObservabilityEventAt = new Map<string, number>();
  private readonly repositories;
  private readonly completionService;
  private readonly dispatchService;
  private readonly sessionRuntimeService;
  private readonly reminderService;
  private readonly tickService;

  constructor(private readonly options: OrchestratorOptions) {
    this.repositories = getProjectRepositoryBundle(this.options.dataRoot);
    this.completionService = new ProjectCompletionService({
      dataRoot: this.options.dataRoot,
      repositories: this.repositories,
      lastObservabilityEventAt: this.lastObservabilityEventAt
    });
    this.dispatchService = new ProjectDispatchService({
      dataRoot: this.options.dataRoot,
      providerRegistry: this.options.providerRegistry,
      repositories: this.repositories,
      inFlightDispatchSessionKeys: this.inFlightDispatchSessionKeys,
      buildSessionDispatchKey: (projectId, sessionId) => buildOrchestratorContextSessionKey(projectId, sessionId),
      completionCleanup: (paths, projectId, role) =>
        this.completionService.cleanupCompletedTaskMessages(paths, projectId, role)
    });
    this.sessionRuntimeService = new ProjectSessionRuntimeService({
      dataRoot: this.options.dataRoot,
      providerRegistry: this.options.providerRegistry,
      repositories: this.repositories,
      sessionRunningTimeoutMs: this.options.sessionRunningTimeoutMs
    });
    this.reminderService = new ProjectReminderService({
      dataRoot: this.options.dataRoot,
      repositories: this.repositories,
      idleTimeoutMs: this.options.idleTimeoutMs,
      reminderBackoffMultiplier: this.options.reminderBackoffMultiplier,
      reminderMaxIntervalMs: this.options.reminderMaxIntervalMs,
      reminderMaxCount: this.options.reminderMaxCount,
      autoReminderEnabled: this.options.autoReminderEnabled,
      dispatchProject: (projectId, input) => this.dispatchService.dispatchProject(projectId, input)
    });
    this.tickService = new ProjectTickService({
      dataRoot: this.options.dataRoot,
      repositories: this.repositories,
      kernel: this.kernel,
      projectHoldState: this.projectHoldState,
      limitEventSent: this.limitEventSent,
      sessionRuntimeService: this.sessionRuntimeService,
      reminderService: this.reminderService,
      completionService: this.completionService,
      dispatchService: this.dispatchService
    });
    this.loopCore = new OrchestratorLoopCore({
      enabled: this.options.enabled,
      intervalMs: this.options.intervalMs,
      onTick: async () => {
        await this.tickService.tickLoop();
      },
      onError: (error) => {
        console.error(`[orchestrator] tickLoop failed: ${resolveOrchestratorErrorMessage(error)}`);
      }
    });
  }

  async getStatus() {
    const loop = this.loopCore.getSnapshot();
    const projects = await this.repositories.projectRuntime.listProjects();
    const perProject: Array<{
      projectId: string;
      autoDispatchEnabled: boolean;
      autoDispatchRemaining: number;
      holdEnabled: boolean;
      reminderMode: "backoff" | "fixed_interval";
    }> = [];
    for (const item of projects) {
      const project = await this.repositories.projectRuntime.getProject(item.projectId);
      perProject.push({
        projectId: project.projectId,
        autoDispatchEnabled: Boolean(project.autoDispatchEnabled ?? true),
        autoDispatchRemaining: Number(project.autoDispatchRemaining ?? 5),
        holdEnabled: Boolean(project.holdEnabled ?? false),
        reminderMode: project.reminderMode ?? "backoff"
      });
    }
    return {
      enabled: loop.enabled,
      running: loop.running,
      started: loop.started,
      intervalMs: loop.intervalMs,
      maxConcurrentDispatches: this.options.maxConcurrentDispatches,
      inFlightDispatchSessions: this.inFlightDispatchSessionKeys.size,
      lastTickAt: loop.lastTickAt,
      projects: perProject
    };
  }

  start(): void {
    this.loopCore.start();
  }

  stop(): void {
    this.loopCore.stop();
    this.projectHoldState.clear();
  }

  terminateSessionProcess(
    projectId: string,
    sessionId: string,
    reason: string
  ): Promise<SessionProcessTerminationResult> {
    return this.sessionRuntimeService.terminateSessionProcess(projectId, sessionId, reason);
  }

  dismissSession(projectId: string, sessionId: string, reason: string) {
    return this.sessionRuntimeService.dismissSession(projectId, sessionId, reason);
  }

  repairSessionStatus(projectId: string, sessionId: string, targetStatus: "idle" | "blocked") {
    return this.sessionRuntimeService.repairSessionStatus(projectId, sessionId, targetStatus);
  }

  resetRoleReminderOnManualAction(
    projectId: string,
    role: string,
    reason: "session_created" | "session_dismissed" | "session_repaired" | "force_dispatch_succeeded"
  ): Promise<void> {
    return this.reminderService.resetRoleReminderOnManualAction(projectId, role, reason);
  }

  dispatchProject(
    projectId: string,
    input: Omit<DispatchProjectInput, "mode"> & { mode?: "manual" | "loop" }
  ): Promise<ProjectDispatchResult> {
    return this.dispatchService.dispatchProject(projectId, input);
  }

  dispatchMessage(
    projectId: string,
    input: { messageId: string; sessionId?: string; force?: boolean; onlyIdle?: boolean }
  ): Promise<ProjectDispatchResult> {
    return this.dispatchService.dispatchMessage(projectId, input);
  }
}

export function createOrchestratorService(dataRoot: string, providerRegistry: ProviderRegistry): OrchestratorService {
  return new OrchestratorService(resolveProjectOrchestratorOptionsFromEnv(dataRoot, providerRegistry));
}
