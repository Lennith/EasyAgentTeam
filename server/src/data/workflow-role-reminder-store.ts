import type {
  WorkflowRoleReminderState,
  WorkflowRoleRemindersState
} from "../domain/models.js";
import { readJsonFile, writeJsonFile } from "./store/store-runtime.js";
import { getWorkflowRunRuntimePaths } from "./workflow-run-store.js";

function defaultWorkflowRoleRemindersState(runId: string): WorkflowRoleRemindersState {
  return {
    schemaVersion: "1.0",
    runId,
    updatedAt: new Date().toISOString(),
    roleReminders: []
  };
}

export async function readWorkflowRoleRemindersState(
  dataRoot: string,
  runId: string
): Promise<WorkflowRoleRemindersState> {
  const paths = getWorkflowRunRuntimePaths(dataRoot, runId);
  return readJsonFile<WorkflowRoleRemindersState>(
    paths.roleRemindersFile,
    defaultWorkflowRoleRemindersState(runId)
  );
}

export async function getWorkflowRoleReminderState(
  dataRoot: string,
  runId: string,
  role: string
): Promise<WorkflowRoleReminderState | null> {
  const normalizedRole = role.trim();
  if (!normalizedRole) {
    return null;
  }
  const state = await readWorkflowRoleRemindersState(dataRoot, runId);
  return state.roleReminders.find((item) => item.role === normalizedRole) ?? null;
}

export async function updateWorkflowRoleReminderState(
  dataRoot: string,
  runId: string,
  role: string,
  updates: Partial<Omit<WorkflowRoleReminderState, "role">>
): Promise<WorkflowRoleReminderState> {
  const normalizedRole = role.trim();
  if (!normalizedRole) {
    throw new Error("role is required");
  }
  const paths = getWorkflowRunRuntimePaths(dataRoot, runId);
  const state = await readJsonFile<WorkflowRoleRemindersState>(
    paths.roleRemindersFile,
    defaultWorkflowRoleRemindersState(runId)
  );
  const now = new Date().toISOString();
  const idx = state.roleReminders.findIndex((item) => item.role === normalizedRole);

  if (idx >= 0) {
    const existing = state.roleReminders[idx];
    const updated: WorkflowRoleReminderState = {
      ...existing,
      ...updates,
      role: normalizedRole,
      reminderCount: updates.reminderCount ?? existing.reminderCount
    };
    state.roleReminders[idx] = updated;
    state.updatedAt = now;
    await writeJsonFile(paths.roleRemindersFile, state);
    return updated;
  }

  const created: WorkflowRoleReminderState = {
    role: normalizedRole,
    idleSince: updates.idleSince,
    reminderCount: updates.reminderCount ?? 0,
    nextReminderAt: updates.nextReminderAt,
    lastRoleState: updates.lastRoleState
  };
  state.roleReminders.push(created);
  state.updatedAt = now;
  await writeJsonFile(paths.roleRemindersFile, state);
  return created;
}
