import type { ProjectRepositoryBundle } from "../../../data/repository/project/repository-bundle.js";
import type { ProjectPaths, ProjectRecord, SessionRecord, TaskRecord } from "../../../domain/models.js";
import type { DispatchProjectInput, SessionDispatchResult } from "./project-orchestrator-types.js";
import { areTaskDependenciesSatisfied, isForceDispatchableState } from "./project-dispatch-policy.js";

export interface ResolveProjectTaskSelectionInput {
  repositories: ProjectRepositoryBundle;
  project: ProjectRecord;
  paths: ProjectPaths;
  session: SessionRecord;
  input: DispatchProjectInput;
  allTasks: TaskRecord[];
  prioritizedRunnableTasks: TaskRecord[];
  runnableTasks: TaskRecord[];
}

type ProjectTaskSelectionResult =
  | { status: "selected"; task: TaskRecord | null }
  | { status: "skipped"; result: SessionDispatchResult };

export async function resolveProjectTaskSelection(
  params: ResolveProjectTaskSelectionInput
): Promise<ProjectTaskSelectionResult> {
  const { repositories, project, paths, session, input, allTasks, prioritizedRunnableTasks, runnableTasks } = params;
  let taskCandidate: TaskRecord | null = !input.force
    ? (prioritizedRunnableTasks.find((task) => task.state !== "MAY_BE_DONE") ?? null)
    : (prioritizedRunnableTasks[0] ?? null);

  if (!input.taskId) {
    return { status: "selected", task: taskCandidate };
  }

  const targetTask = allTasks.find((task) => task.taskId === input.taskId);
  if (!targetTask) {
    return {
      status: "skipped",
      result: {
        sessionId: session.sessionId,
        role: session.role,
        outcome: "task_not_found",
        dispatchKind: "task",
        taskId: input.taskId,
        reason: `task '${input.taskId}' does not exist (next_action: refresh task-tree and retry with current task_id)`
      }
    };
  }
  if (targetTask.state === "DONE") {
    return {
      status: "skipped",
      result: {
        sessionId: session.sessionId,
        role: session.role,
        outcome: "task_already_done",
        dispatchKind: "task",
        taskId: input.taskId,
        reason: `task '${input.taskId}' is already DONE`
      }
    };
  }

  if (input.force) {
    if (!isForceDispatchableState(targetTask.state)) {
      return {
        status: "skipped",
        result: {
          sessionId: session.sessionId,
          role: session.role,
          outcome: "task_not_force_dispatchable",
          dispatchKind: "task",
          taskId: input.taskId,
          reason: `task '${input.taskId}' state=${targetTask.state} is not force-dispatchable`
        }
      };
    }
    if (session.role !== targetTask.ownerRole) {
      return {
        status: "skipped",
        result: {
          sessionId: session.sessionId,
          role: session.role,
          outcome: "task_owner_mismatch",
          dispatchKind: "task",
          taskId: input.taskId,
          reason: `task '${input.taskId}' belongs to role '${targetTask.ownerRole}', but session role is '${session.role}'`
        }
      };
    }
    taskCandidate = targetTask;
    return { status: "selected", task: taskCandidate };
  }

  const specifiedTask = runnableTasks.find((task) => task.taskId === input.taskId);
  if (!specifiedTask) {
    return {
      status: "skipped",
      result: {
        sessionId: session.sessionId,
        role: session.role,
        outcome: "task_not_found",
        dispatchKind: "task",
        taskId: input.taskId,
        reason: `task '${input.taskId}' is not runnable for session '${session.sessionId}'`
      }
    };
  }
  const dependencyGate = areTaskDependenciesSatisfied(specifiedTask, allTasks);
  if (!dependencyGate.satisfied) {
    await repositories.events.appendEvent(paths, {
      projectId: project.projectId,
      eventType: "ORCHESTRATOR_DISPATCH_SKIPPED",
      source: "manager",
      sessionId: session.sessionId,
      taskId: input.taskId,
      payload: {
        mode: input.mode,
        dispatchKind: "task",
        dispatchSkipReason: "dependency_gate_closed",
        unsatisfiedDependencyIds: dependencyGate.unsatisfiedDeps,
        blockingTaskIds: dependencyGate.blockingTaskIds
      }
    });
    return {
      status: "skipped",
      result: {
        sessionId: session.sessionId,
        role: session.role,
        outcome: "task_not_found",
        dispatchKind: "task",
        taskId: input.taskId,
        reason: `task '${input.taskId}' dependency gate is closed; unsatisfied_dependencies=[${dependencyGate.unsatisfiedDeps.join(", ")}], blocking_tasks=[${dependencyGate.blockingTaskIds.join(", ")}]`
      }
    };
  }
  taskCandidate = specifiedTask;
  return { status: "selected", task: taskCandidate };
}
