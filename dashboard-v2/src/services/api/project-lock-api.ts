import type { LockRecord } from "@/types/project";
import { API_BASE, fetchJSON } from "./shared/http";

export const projectLockApi = {
  getLocks: (projectId: string) =>
    fetchJSON<{ items: LockRecord[] }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/locks`),

  acquireLock: (
    projectId: string,
    data: { session_id: string; target_type: "file" | "dir"; lock_key: string; ttl_seconds: number; purpose?: string }
  ) =>
    fetchJSON<{ result: string }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/locks/acquire`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  renewLock: (projectId: string, data: { session_id: string; lock_key: string }) =>
    fetchJSON<{ result: string }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/locks/renew`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  releaseLock: (projectId: string, data: { session_id: string; lock_key: string }) =>
    fetchJSON<{ result: string }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/locks/release`, {
      method: "POST",
      body: JSON.stringify(data)
    })
};
