import type { ReminderMessageBody, ReminderMode, ReminderTaskPayload } from "../domain/models.js";

interface ReminderOpenTaskInput {
  taskId: string;
  title: string;
}

interface BuildReminderMessageBodyInput {
  role: string;
  reminderMode: ReminderMode;
  reminderCount: number;
  nextReminderAt: string | null | undefined;
  openTasks: ReminderOpenTaskInput[];
  content: string;
  primaryTaskId: string | null;
  primarySummary?: string | null;
  primaryTask?: ReminderTaskPayload | null;
}

export function buildReminderMessageBody(input: BuildReminderMessageBodyInput): ReminderMessageBody {
  return {
    mode: "CHAT",
    messageType: "MANAGER_MESSAGE",
    content: input.content,
    taskId: input.primaryTaskId,
    summary: input.primarySummary?.trim() ?? "",
    task: input.primaryTask ?? null,
    reminder: {
      role: input.role,
      reminder_mode: input.reminderMode,
      reminder_count: input.reminderCount,
      open_task_ids: input.openTasks.map((task) => task.taskId),
      open_task_titles: input.openTasks.map((task) => ({
        task_id: task.taskId,
        title: task.title
      })),
      next_reminder_at: input.nextReminderAt ?? null
    },
    taskHint: input.primaryTaskId
  };
}
