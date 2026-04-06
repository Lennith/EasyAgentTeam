import type { WorkflowTimelineItem } from "../domain/models.js";
import { listWorkflowRunEvents } from "../data/repository/workflow/runtime-repository.js";
import { buildAgentTimelineFromEvents } from "./agent-io-timeline-core.js";

interface BuildTimelineOptions {
  limit?: number;
}

export async function buildWorkflowAgentIOTimeline(
  dataRoot: string,
  runId: string,
  options: BuildTimelineOptions = {}
): Promise<{ items: WorkflowTimelineItem[]; total: number }> {
  const events = await listWorkflowRunEvents(dataRoot, runId);
  const timeline = buildAgentTimelineFromEvents(events, {
    ...options,
    includeRequestedSkillIds: true
  });
  return {
    items: timeline.items as WorkflowTimelineItem[],
    total: timeline.total
  };
}
