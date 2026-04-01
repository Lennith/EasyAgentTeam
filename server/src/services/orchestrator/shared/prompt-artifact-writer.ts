import fs from "node:fs/promises";
import path from "node:path";

export interface WriteOrchestratorPromptArtifactInput {
  directory: string;
  startedAt: string;
  sessionId: string;
  dispatchId: string;
  prompt: string;
}

export async function writeOrchestratorPromptArtifact(input: WriteOrchestratorPromptArtifactInput): Promise<string> {
  await fs.mkdir(input.directory, { recursive: true });
  const fileName = `${input.startedAt.replace(/[:.]/g, "-")}_${input.sessionId}_${input.dispatchId}.md`;
  const filePath = path.join(input.directory, fileName);
  await fs.writeFile(filePath, input.prompt, "utf-8");
  return filePath;
}
