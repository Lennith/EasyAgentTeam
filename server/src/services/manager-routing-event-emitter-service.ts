import type { EventRecord, ProjectPaths } from "../domain/models.js";
import { appendEvent } from "../data/event-store.js";
import {
  buildManagerMessageRoutedPayload,
  buildMessageRoutedPayload,
  buildUserMessageReceivedPayload,
  type ManagerMessageRoutedPayloadInput,
  type MessageRoutedPayloadInput,
  type UserMessageReceivedPayloadInput
} from "./manager-routing-event-service.js";

interface RouteEventContext {
  projectId: string;
  paths: ProjectPaths;
  source: EventRecord["source"];
  sessionId?: string;
  taskId?: string;
}

export async function emitUserMessageReceived(
  context: RouteEventContext,
  input: UserMessageReceivedPayloadInput
): Promise<EventRecord> {
  return appendEvent(context.paths, {
    projectId: context.projectId,
    eventType: "USER_MESSAGE_RECEIVED",
    source: context.source,
    sessionId: context.sessionId,
    taskId: context.taskId,
    payload: buildUserMessageReceivedPayload(input)
  });
}

export async function emitMessageRouted(
  context: RouteEventContext,
  input: MessageRoutedPayloadInput
): Promise<EventRecord> {
  return appendEvent(context.paths, {
    projectId: context.projectId,
    eventType: "MESSAGE_ROUTED",
    source: context.source,
    sessionId: context.sessionId,
    taskId: context.taskId,
    payload: buildMessageRoutedPayload(input)
  });
}

export async function emitManagerMessageRouted(
  context: RouteEventContext,
  input: ManagerMessageRoutedPayloadInput
): Promise<EventRecord> {
  return appendEvent(context.paths, {
    projectId: context.projectId,
    eventType: "MANAGER_MESSAGE_ROUTED",
    source: context.source,
    sessionId: context.sessionId,
    taskId: context.taskId,
    payload: buildManagerMessageRoutedPayload(input)
  });
}
