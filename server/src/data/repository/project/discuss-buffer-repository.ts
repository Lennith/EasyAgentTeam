import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectPaths } from "../../../domain/models.js";
import {
  appendJsonlLine,
  getStorageBackend,
  readJsonlLines,
  writeJsonlLines
} from "../../internal/persistence/store/store-runtime.js";

export interface BufferedDiscussPayload {
  taskId: string;
  threadId: string;
  round: number;
  discussId: string;
  maxRounds: number;
  inReplyTo?: string;
  title?: string;
}

export interface BufferedDiscussMessage {
  schemaVersion: "1.0";
  bufferId: string;
  projectId: string;
  parentRequestId: string;
  requestId: string;
  fromAgent: string;
  toRole?: string;
  toSessionId: string;
  mode: "CHAT";
  messageType: "TASK_DISCUSS_REQUEST";
  content: string;
  taskId?: string;
  discuss?: BufferedDiscussPayload;
  createdAt: string;
}

function sanitizeKey(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
}

function resolveBufferFile(paths: ProjectPaths, parentRequestId: string): string {
  const safe = sanitizeKey(parentRequestId) || "unknown";
  return path.join(paths.outboxDir, `discuss-buffer-${safe}.jsonl`);
}

export async function appendBufferedDiscussMessage(
  paths: ProjectPaths,
  input: Omit<BufferedDiscussMessage, "schemaVersion" | "bufferId">
): Promise<BufferedDiscussMessage> {
  const row: BufferedDiscussMessage = {
    schemaVersion: "1.0",
    bufferId: randomUUID(),
    ...input
  };
  const file = resolveBufferFile(paths, input.parentRequestId);
  await appendJsonlLine(file, row);
  return row;
}

export async function listBufferedDiscussMessages(
  paths: ProjectPaths,
  parentRequestId: string
): Promise<BufferedDiscussMessage[]> {
  const file = resolveBufferFile(paths, parentRequestId);
  return readJsonlLines<BufferedDiscussMessage>(file);
}

export async function clearBufferedDiscussMessages(paths: ProjectPaths, parentRequestId: string): Promise<void> {
  const file = resolveBufferFile(paths, parentRequestId);
  if (getStorageBackend() === "memory") {
    await writeJsonlLines(file, []);
    return;
  }
  try {
    await fs.unlink(file);
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code !== "ENOENT") {
      throw error;
    }
  }
}
