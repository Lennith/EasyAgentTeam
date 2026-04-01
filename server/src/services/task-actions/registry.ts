import type { TaskActionType } from "../../domain/models.js";
import { defaultTaskActionHandlers } from "./handlers.js";
import type { TaskActionHandler, TaskActionHandlerContext } from "./types.js";

export class TaskActionRegistry {
  private readonly handlerByActionType = new Map<TaskActionType, TaskActionHandler>();

  constructor(handlers: TaskActionHandler[] = defaultTaskActionHandlers) {
    for (const handler of handlers) {
      for (const actionType of handler.actionTypes) {
        this.handlerByActionType.set(actionType, handler);
      }
    }
  }

  resolve(actionType: TaskActionType): TaskActionHandler | undefined {
    return this.handlerByActionType.get(actionType);
  }

  async handle(context: TaskActionHandlerContext) {
    const handler = this.resolve(context.actionType);
    if (!handler) {
      throw new Error(`TASK_ACTION_HANDLER_NOT_FOUND: ${context.actionType}`);
    }
    return handler.handle(context);
  }
}

export const defaultTaskActionRegistry = new TaskActionRegistry();
