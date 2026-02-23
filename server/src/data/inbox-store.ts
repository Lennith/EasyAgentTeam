import path from "node:path";
import fs from "node:fs/promises";
import type { ManagerToAgentMessage, ProjectPaths } from "../domain/models.js";
import { appendJsonlLine, readJsonlLines, writeJsonlLines } from "./file-utils.js";

export async function appendInboxMessage(
  paths: ProjectPaths,
  targetRole: string,
  message: ManagerToAgentMessage
): Promise<string> {
  const filename = `${targetRole}.jsonl`;
  const inboxFile = path.join(paths.inboxDir, filename);
  await appendJsonlLine(inboxFile, message);
  return inboxFile;
}

export async function listInboxMessages(
  paths: ProjectPaths,
  targetRole: string,
  limit?: number
): Promise<ManagerToAgentMessage[]> {
  const filename = `${targetRole}.jsonl`;
  const inboxFile = path.join(paths.inboxDir, filename);
  const all = await readJsonlLines<ManagerToAgentMessage>(inboxFile);
  if (!limit || limit <= 0 || all.length <= limit) {
    return all;
  }
  return all.slice(all.length - limit);
}

export async function removeInboxMessages(
  paths: ProjectPaths,
  targetRole: string,
  messageIds: string[]
): Promise<number> {
  if (messageIds.length === 0) {
    return 0;
  }
  const filename = `${targetRole}.jsonl`;
  const inboxFile = path.join(paths.inboxDir, filename);
  
  const all = await readJsonlLines<ManagerToAgentMessage>(inboxFile);
  const idsToRemove = new Set(messageIds);
  const remaining = all.filter((msg) => !idsToRemove.has(msg.envelope.message_id));
  
  if (remaining.length < all.length) {
    await writeJsonlLines(inboxFile, remaining);
    return all.length - remaining.length;
  }
  return 0;
}
