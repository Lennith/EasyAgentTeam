import type { ManagerToAgentMessage, ProjectPaths } from "../../domain/models.js";
import { appendInboxMessage, listInboxMessages, removeInboxMessages } from "../inbox-store.js";

export interface InboxRepository {
  appendInboxMessage(paths: ProjectPaths, targetRole: string, message: ManagerToAgentMessage): Promise<string>;
  listInboxMessages(paths: ProjectPaths, targetRole: string, limit?: number): Promise<ManagerToAgentMessage[]>;
  removeInboxMessages(paths: ProjectPaths, targetRole: string, messageIds: string[]): Promise<number>;
}

class DefaultInboxRepository implements InboxRepository {
  appendInboxMessage(paths: ProjectPaths, targetRole: string, message: ManagerToAgentMessage): Promise<string> {
    return appendInboxMessage(paths, targetRole, message);
  }

  listInboxMessages(paths: ProjectPaths, targetRole: string, limit?: number): Promise<ManagerToAgentMessage[]> {
    return listInboxMessages(paths, targetRole, limit);
  }

  removeInboxMessages(paths: ProjectPaths, targetRole: string, messageIds: string[]): Promise<number> {
    return removeInboxMessages(paths, targetRole, messageIds);
  }
}

export function createInboxRepository(): InboxRepository {
  return new DefaultInboxRepository();
}
