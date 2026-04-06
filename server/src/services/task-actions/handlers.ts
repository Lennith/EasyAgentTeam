import type { TaskActionHandler } from "./types.js";
import { getProjectRepositoryBundle } from "../../data/repository/project/repository-bundle.js";
import { applyTaskReportAction } from "./report-processing.js";
import { applyTaskAssignAction, applyTaskCreateAction } from "./assignment-processing.js";
import { applyTaskUpdateAction } from "./update-processing.js";
import { applyTaskDiscussAction } from "./discuss-processing.js";
import { runTaskActionWriteContext } from "./write-context.js";

function getTaskActionRepositories(dataRoot: string) {
  return getProjectRepositoryBundle(dataRoot);
}

export const createTaskActionHandler: TaskActionHandler = {
  actionTypes: ["TASK_CREATE"],
  async handle(context) {
    const { dataRoot, project, paths, actionInput, requestId, fromAgent, fromSessionId, toRole, toSessionId } = context;
    const repositories = getTaskActionRepositories(dataRoot);
    return runTaskActionWriteContext(
      dataRoot,
      { project, paths },
      async () =>
        await applyTaskCreateAction({
          dataRoot,
          project,
          paths,
          repositories,
          actionInput,
          requestId,
          fromAgent,
          fromSessionId,
          toRole,
          toSessionId
        })
    );
  }
};

export const updateTaskActionHandler: TaskActionHandler = {
  actionTypes: ["TASK_UPDATE"],
  async handle(context) {
    const { dataRoot, project, paths, actionInput, requestId, fromSessionId, defaultTaskId } = context;
    const repositories = getTaskActionRepositories(dataRoot);
    return runTaskActionWriteContext(
      dataRoot,
      { project, paths },
      async () =>
        await applyTaskUpdateAction({
          project,
          paths,
          repositories,
          actionInput,
          requestId,
          fromSessionId,
          defaultTaskId
        })
    );
  }
};

export const assignTaskActionHandler: TaskActionHandler = {
  actionTypes: ["TASK_ASSIGN"],
  async handle(context) {
    const {
      dataRoot,
      project,
      paths,
      actionInput,
      requestId,
      fromAgent,
      fromSessionId,
      toRole,
      toSessionId,
      defaultTaskId
    } = context;
    const repositories = getTaskActionRepositories(dataRoot);
    return runTaskActionWriteContext(
      dataRoot,
      { project, paths },
      async () =>
        await applyTaskAssignAction({
          dataRoot,
          project,
          paths,
          repositories,
          actionInput,
          requestId,
          fromAgent,
          fromSessionId,
          toRole,
          toSessionId,
          defaultTaskId
        })
    );
  }
};

export const discussTaskActionHandler: TaskActionHandler = {
  actionTypes: ["TASK_DISCUSS_REQUEST", "TASK_DISCUSS_REPLY", "TASK_DISCUSS_CLOSED"],
  async handle(context) {
    const {
      dataRoot,
      project,
      paths,
      actionType,
      actionInput,
      requestId,
      fromAgent,
      fromSessionId,
      toRole,
      toSessionId,
      defaultTaskId
    } = context;
    const repositories = getTaskActionRepositories(dataRoot);
    return await applyTaskDiscussAction({
      dataRoot,
      project,
      paths,
      repositories,
      actionType: actionType as "TASK_DISCUSS_REQUEST" | "TASK_DISCUSS_REPLY" | "TASK_DISCUSS_CLOSED",
      actionInput,
      requestId,
      fromAgent,
      fromSessionId,
      toRole,
      toSessionId,
      defaultTaskId
    });
  }
};

export const reportTaskActionHandler: TaskActionHandler = {
  actionTypes: ["TASK_REPORT"],
  async handle(context) {
    const { dataRoot, project, paths, actionInput, requestId, fromAgent, fromSessionId } = context;
    const repositories = getTaskActionRepositories(dataRoot);
    return runTaskActionWriteContext(
      dataRoot,
      { project, paths },
      async () =>
        await applyTaskReportAction({
          dataRoot,
          project,
          paths,
          repositories,
          actionInput,
          requestId,
          fromAgent,
          fromSessionId
        })
    );
  }
};

export const defaultTaskActionHandlers: TaskActionHandler[] = [
  createTaskActionHandler,
  updateTaskActionHandler,
  assignTaskActionHandler,
  discussTaskActionHandler,
  reportTaskActionHandler
];
