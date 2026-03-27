import type { ProjectPaths, RoleReminderState, RoleRemindersState } from "../domain/models.js";
import { readJsonFile, writeJsonFile } from "./store/store-runtime.js";

function defaultRoleRemindersState(projectId: string): RoleRemindersState {
  return {
    schemaVersion: "1.0",
    projectId,
    updatedAt: new Date().toISOString(),
    roleReminders: []
  };
}

export async function readRoleRemindersState(
  paths: ProjectPaths,
  projectId: string
): Promise<RoleRemindersState> {
  return readJsonFile<RoleRemindersState>(paths.roleRemindersFile, defaultRoleRemindersState(projectId));
}

export async function getRoleReminderState(
  paths: ProjectPaths,
  projectId: string,
  role: string
): Promise<RoleReminderState | null> {
  const state = await readRoleRemindersState(paths, projectId);
  const normalizedRole = role.trim();
  return state.roleReminders.find((item) => item.role === normalizedRole) ?? null;
}

export async function updateRoleReminderState(
  paths: ProjectPaths,
  projectId: string,
  role: string,
  updates: Partial<Omit<RoleReminderState, "role">>
): Promise<RoleReminderState> {
  const state = await readRoleRemindersState(paths, projectId);
  const normalizedRole = role.trim();
  const now = new Date().toISOString();

  const idx = state.roleReminders.findIndex((item) => item.role === normalizedRole);

  if (idx >= 0) {
    const existing = state.roleReminders[idx];
    const updated: RoleReminderState = {
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

  const newReminder: RoleReminderState = {
    role: normalizedRole,
    idleSince: updates.idleSince,
    reminderCount: updates.reminderCount ?? 0,
    nextReminderAt: updates.nextReminderAt,
    lastRoleState: updates.lastRoleState
  };
  state.roleReminders.push(newReminder);
  state.updatedAt = now;
  await writeJsonFile(paths.roleRemindersFile, state);
  return newReminder;
}
