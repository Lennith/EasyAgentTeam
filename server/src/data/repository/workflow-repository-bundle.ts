import path from "node:path";
import type { WorkflowRunRecord } from "../../domain/models.js";
import { getWorkflowRunRuntimePaths } from "../workflow-run-store.js";
import { getRepository, getUnitOfWork } from "./runtime.js";
import type { Repository, UnitOfWork } from "./types.js";
import {
  createWorkflowEventRepository,
  type WorkflowEventRepository
} from "./workflow-event-repository.js";
import {
  createWorkflowInboxRepository,
  type WorkflowInboxRepository
} from "./workflow-inbox-repository.js";
import {
  createWorkflowReminderRepository,
  type WorkflowReminderRepository
} from "./workflow-reminder-repository.js";
import {
  createWorkflowRunRepository,
  type WorkflowRunRepository
} from "./workflow-run-repository.js";
import {
  createWorkflowSessionRepository,
  type WorkflowSessionRepository
} from "./workflow-session-repository.js";

export interface ResolvedWorkflowRepositoryScope {
  run: WorkflowRunRecord;
}

export interface WorkflowRepositoryBundle {
  dataRoot: string;
  repository: Repository;
  unitOfWork: UnitOfWork;
  workflowRuns: WorkflowRunRepository;
  sessions: WorkflowSessionRepository;
  events: WorkflowEventRepository;
  inbox: WorkflowInboxRepository;
  reminders: WorkflowReminderRepository;
  resolveScope(runId: string): Promise<ResolvedWorkflowRepositoryScope>;
  runInUnitOfWork<T>(scope: ResolvedWorkflowRepositoryScope, operation: () => Promise<T>): Promise<T>;
  runWithResolvedScope<T>(
    runId: string,
    operation: (scope: ResolvedWorkflowRepositoryScope) => Promise<T>
  ): Promise<T>;
}

class DefaultWorkflowRepositoryBundle implements WorkflowRepositoryBundle {
  readonly repository: Repository;
  readonly unitOfWork: UnitOfWork;
  readonly workflowRuns: WorkflowRunRepository;
  readonly sessions: WorkflowSessionRepository;
  readonly events: WorkflowEventRepository;
  readonly inbox: WorkflowInboxRepository;
  readonly reminders: WorkflowReminderRepository;

  constructor(public readonly dataRoot: string) {
    this.repository = getRepository();
    this.unitOfWork = getUnitOfWork();
    this.workflowRuns = createWorkflowRunRepository(this.dataRoot);
    this.sessions = createWorkflowSessionRepository(this.dataRoot);
    this.events = createWorkflowEventRepository(this.dataRoot);
    this.inbox = createWorkflowInboxRepository(this.dataRoot);
    this.reminders = createWorkflowReminderRepository(this.dataRoot);
  }

  async resolveScope(runId: string): Promise<ResolvedWorkflowRepositoryScope> {
    const run = await this.workflowRuns.getRun(runId);
    if (!run) {
      throw new Error(`run '${runId}' not found`);
    }
    return { run };
  }

  runInUnitOfWork<T>(scope: ResolvedWorkflowRepositoryScope, operation: () => Promise<T>): Promise<T> {
    const paths = getWorkflowRunRuntimePaths(this.dataRoot, scope.run.runId);
    return this.unitOfWork.run([path.join(this.dataRoot, "workflows"), paths.runRootDir], operation);
  }

  runWithResolvedScope<T>(
    runId: string,
    operation: (scope: ResolvedWorkflowRepositoryScope) => Promise<T>
  ): Promise<T> {
    return this.resolveScope(runId).then((scope) => this.runInUnitOfWork(scope, () => operation(scope)));
  }
}

const bundleCache = new Map<string, WorkflowRepositoryBundle>();

export function createWorkflowRepositoryBundle(dataRoot: string): WorkflowRepositoryBundle {
  return new DefaultWorkflowRepositoryBundle(dataRoot);
}

export function getWorkflowRepositoryBundle(dataRoot: string): WorkflowRepositoryBundle {
  const cached = bundleCache.get(dataRoot);
  if (cached) {
    return cached;
  }
  const created = createWorkflowRepositoryBundle(dataRoot);
  bundleCache.set(dataRoot, created);
  return created;
}
