import type { ProjectPaths, ProjectRecord } from "../domain/models.js";
import { listEvents } from "../data/repository/project/event-repository.js";
import { buildAgentTimelineFromEvents, type AgentTimelineItem } from "./agent-io-timeline-core.js";

export type AgentIOTimelineItem = AgentTimelineItem;

interface BuildTimelineOptions {
  limit?: number;
}

export async function buildAgentIOTimeline(
  _project: ProjectRecord,
  paths: ProjectPaths,
  options: BuildTimelineOptions = {}
): Promise<{ items: AgentIOTimelineItem[]; total: number }> {
  const events = await listEvents(paths);
  return buildAgentTimelineFromEvents(events, options);
}
