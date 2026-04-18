import type { ProjectRecord } from "../../../domain/models.js";
import type { OrchestratorKernel } from "../shared/kernel/orchestrator-kernel.js";
import type { ProjectDispatchService } from "./project-dispatch-service.js";
import type { ProjectCompletionService } from "./project-completion-service.js";
import type { ProjectReminderService } from "./project-reminder-service.js";
import type { ProjectSessionRuntimeService } from "./project-session-runtime-service.js";
import type {
  ProjectRepositoryBundle,
  ResolvedProjectRepositoryScope
} from "../../../data/repository/project/repository-bundle.js";
import {
  createAdapterBackedOrchestratorTickPipeline,
  runAdapterBackedOrchestratorTickLoop,
  syncOrchestratorHoldState,
  type OrchestratorTickPipeline
} from "../shared/tick-pipeline.js";

interface ProjectTickServiceOptions {
  dataRoot: string;
  repositories: ProjectRepositoryBundle;
  kernel: OrchestratorKernel;
  projectHoldState: Map<string, boolean>;
  limitEventSent: Set<string>;
  sessionRuntimeService: ProjectSessionRuntimeService;
  reminderService: ProjectReminderService;
  completionService: ProjectCompletionService;
  dispatchService: ProjectDispatchService;
}

export class ProjectTickService {
  private readonly tickPipeline: OrchestratorTickPipeline<ResolvedProjectRepositoryScope>;

  constructor(private readonly options: ProjectTickServiceOptions) {
    this.tickPipeline = createAdapterBackedOrchestratorTickPipeline<ResolvedProjectRepositoryScope>({
      phaseOrder: ["timeout", "reminder", "completion", "observability", "autoDispatchBudget"],
      scopeIsOnHold: (scope) => Boolean(scope.project.holdEnabled ?? false),
      sessionRuntime: {
        markTimedOut: async (scope) => {
          await this.options.sessionRuntimeService.markTimedOutSessions(scope.project, scope.paths);
        }
      },
      reminder: {
        checkReminders: async (scope) => {
          await this.options.reminderService.checkIdleRoles(scope.project, scope.paths);
        }
      },
      completion: {
        runCompletion: async () => {},
        emitObservabilitySnapshot: async (scope) => {
          await this.options.completionService.emitDispatchObservabilitySnapshot(scope.project, scope.paths);
        }
      },
      updateAutoDispatchBudget: async (scope) => {
        await this.consumeAutoDispatchBudget(scope.project.projectId);
      }
    });
  }

  async tickLoop(): Promise<void> {
    const projectIndex = await this.options.repositories.projectRuntime.listProjects();
    await runAdapterBackedOrchestratorTickLoop({
      kernel: this.options.kernel,
      listContexts: async () => projectIndex,
      resolveScope: async (item) => await this.options.repositories.resolveScope(item.projectId),
      beforeScope: async (scope) => {
        await this.handleProjectHoldState(scope.project, scope.paths);
      },
      tickPipeline: this.tickPipeline
    });
  }

  private async handleProjectHoldState(
    project: ProjectRecord,
    paths: ResolvedProjectRepositoryScope["paths"]
  ): Promise<void> {
    const holdEnabled = Boolean(project.holdEnabled ?? false);
    await syncOrchestratorHoldState({
      scopeId: project.projectId,
      holdEnabled,
      previousState: this.options.projectHoldState,
      appendEvent: async (nextHoldEnabled) => {
        await this.options.repositories.events.appendEvent(paths, {
          projectId: project.projectId,
          eventType: nextHoldEnabled ? "ORCHESTRATOR_PROJECT_HOLD_ENABLED" : "ORCHESTRATOR_PROJECT_HOLD_DISABLED",
          source: "manager",
          payload: { holdEnabled: nextHoldEnabled }
        });
      }
    });
  }

  private async consumeAutoDispatchBudget(projectId: string): Promise<void> {
    const project = await this.options.repositories.projectRuntime.getProject(projectId);
    if (!(project.autoDispatchEnabled ?? true)) {
      return;
    }
    const remaining = Number(project.autoDispatchRemaining ?? 5);
    if (remaining <= 0) {
      if (!this.options.limitEventSent.has(project.projectId)) {
        const paths = await this.options.repositories.projectRuntime.ensureProjectRuntime(project.projectId);
        await this.options.repositories.events.appendEvent(paths, {
          projectId: project.projectId,
          eventType: "ORCHESTRATOR_AUTO_LIMIT_REACHED",
          source: "manager",
          payload: {
            autoDispatchRemaining: 0,
            reason: "remaining_exhausted"
          }
        });
        this.options.limitEventSent.add(project.projectId);
      }
      return;
    }
    this.options.limitEventSent.delete(project.projectId);
    const result = await this.options.dispatchService.dispatchProject(project.projectId, {
      mode: "loop",
      onlyIdle: true,
      force: false,
      maxDispatches: remaining
    });
    const consumed = result.results.filter((row) => row.outcome === "dispatched" && row.dispatchKind === "task").length;
    if (consumed > 0) {
      await this.options.repositories.projectRuntime.updateProjectOrchestratorSettings(project.projectId, {
        autoDispatchRemaining: Math.max(0, remaining - consumed)
      });
    }
  }
}
