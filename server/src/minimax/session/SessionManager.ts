import * as crypto from 'crypto';
import type { Session, CreateSessionOptions, Message } from '../types.js';

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private maxSessions: number = 1000;

  generateSessionId(): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `sess-${timestamp}-${random}`;
  }

  create(options: CreateSessionOptions = {}): Session {
    if (this.sessions.size >= this.maxSessions) {
      this.cleanupOldest();
    }

    const id = this.generateSessionId();
    const now = new Date();

    const session: Session = {
      id,
      messages: [],
      createdAt: now,
      updatedAt: now,
      workspaceDir: options.workspaceDir ?? './workspace',
      additionalDirs: options.additionalDirs ?? [],
      systemPrompt: options.systemPrompt,
    };

    this.sessions.set(id, session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  update(sessionId: string, updates: Partial<Session>): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    Object.assign(session, updates, { updatedAt: new Date() });
    return session;
  }

  addMessage(sessionId: string, message: Message): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    session.messages.push(message);
    session.updatedAt = new Date();
    return session;
  }

  getMessages(sessionId: string): Message[] | undefined {
    const session = this.sessions.get(sessionId);
    return session?.messages;
  }

  clearMessages(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    session.messages = [];
    session.updatedAt = new Date();
    return true;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  size(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }

  private cleanupOldest(): void {
    const sessions = Array.from(this.sessions.entries());
    sessions.sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime());

    const toDelete = sessions.slice(0, Math.floor(this.maxSessions * 0.1));
    for (const [id] of toDelete) {
      this.sessions.delete(id);
    }
  }
}

let defaultManager: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!defaultManager) {
    defaultManager = new SessionManager();
  }
  return defaultManager;
}

export function createSessionManager(): SessionManager {
  return new SessionManager();
}
