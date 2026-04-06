import type { ProjectPaths, ProjectRecord } from "../../../domain/models.js";
import { createEventRepository, type EventRepository } from "./event-repository.js";
import { createInboxRepository, type InboxRepository } from "./inbox-repository.js";
import {
  createProjectRuntimeRepository,
  type ProjectRuntimeRepository
} from "./runtime-repository.js";
import { getRepository, getUnitOfWork } from "../shared/runtime.js";
import { createSessionRepository, type SessionRepository } from "./session-repository.js";
import { createTaskboardRepository, type TaskboardRepository } from "./taskboard-repository.js";
import type { Repository, UnitOfWork } from "../shared/types.js";

export interface ResolvedProjectRepositoryScope {
  project: ProjectRecord;
  paths: ProjectPaths;
}

export interface ProjectRepositoryBundle {
  dataRoot: string;
  repository: Repository;
  unitOfWork: UnitOfWork;
  projectRuntime: ProjectRuntimeRepository;
  taskboard: TaskboardRepository;
  sessions: SessionRepository;
  events: EventRepository;
  inbox: InboxRepository;
  resolveScope(projectId: string): Promise<ResolvedProjectRepositoryScope>;
  runInUnitOfWork<T>(scope: ResolvedProjectRepositoryScope, operation: () => Promise<T>): Promise<T>;
  runWithResolvedScope<T>(
    projectId: string,
    operation: (scope: ResolvedProjectRepositoryScope) => Promise<T>
  ): Promise<T>;
}

class DefaultProjectRepositoryBundle implements ProjectRepositoryBundle {
  readonly repository: Repository;
  readonly unitOfWork: UnitOfWork;
  readonly projectRuntime: ProjectRuntimeRepository;
  readonly taskboard: TaskboardRepository;
  readonly sessions: SessionRepository;
  readonly events: EventRepository;
  readonly inbox: InboxRepository;

  constructor(public readonly dataRoot: string) {
    this.repository = getRepository();
    this.unitOfWork = getUnitOfWork();
    this.projectRuntime = createProjectRuntimeRepository(this.dataRoot);
    this.taskboard = createTaskboardRepository();
    this.sessions = createSessionRepository();
    this.events = createEventRepository();
    this.inbox = createInboxRepository();
  }

  async resolveScope(projectId: string): Promise<ResolvedProjectRepositoryScope> {
    const project = await this.projectRuntime.getProject(projectId);
    const paths = await this.projectRuntime.ensureProjectRuntime(project.projectId);
    return { project, paths };
  }

  runInUnitOfWork<T>(scope: ResolvedProjectRepositoryScope, operation: () => Promise<T>): Promise<T> {
    return this.unitOfWork.run([scope.paths.projectRootDir], operation);
  }

  runWithResolvedScope<T>(
    projectId: string,
    operation: (scope: ResolvedProjectRepositoryScope) => Promise<T>
  ): Promise<T> {
    return this.resolveScope(projectId).then((scope) => this.runInUnitOfWork(scope, () => operation(scope)));
  }
}

const bundleCache = new Map<string, ProjectRepositoryBundle>();

export function createProjectRepositoryBundle(dataRoot: string): ProjectRepositoryBundle {
  return new DefaultProjectRepositoryBundle(dataRoot);
}

export function getProjectRepositoryBundle(dataRoot: string): ProjectRepositoryBundle {
  const cached = bundleCache.get(dataRoot);
  if (cached) {
    return cached;
  }
  const created = createProjectRepositoryBundle(dataRoot);
  bundleCache.set(dataRoot, created);
  return created;
}
