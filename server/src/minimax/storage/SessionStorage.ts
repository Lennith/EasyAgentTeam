import * as fs from 'fs';
import * as path from 'path';
import { JSONLWriter, generateMessageId, createPersistedMessage } from './JSONLWriter.js';
import type { 
  PersistedMessage, 
  SessionMeta, 
  SessionStorageConfig,
  Message,
} from '../types.js';

const DEFAULT_CONFIG: Required<SessionStorageConfig> = {
  persistDir: 'minimax-session',
  maxContentSize: 200 * 1024,
  compressionThreshold: 200 * 1024,
  targetCompressionRatio: 0.3,
  autoCompress: true,
};

export class SessionStorage {
  private workspaceDir: string;
  private config: Required<SessionStorageConfig>;
  private sessionDir: string;

  constructor(workspaceDir: string, config?: SessionStorageConfig, sessionDir?: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (sessionDir) {
      this.sessionDir = path.resolve(sessionDir);
    } else {
      this.sessionDir = path.join(this.workspaceDir, this.config.persistDir);
    }
  }

  private getSessionPath(sessionId: string): string {
    return path.join(this.sessionDir, sessionId);
  }

  private getHistoryFilePath(sessionId: string, index: number): string {
    return path.join(this.getSessionPath(sessionId), `history_message_${index}.jsonl`);
  }

  private getMetaFilePath(sessionId: string): string {
    return path.join(this.getSessionPath(sessionId), 'session_meta.json');
  }

  sessionExists(sessionId: string): boolean {
    return fs.existsSync(this.getSessionPath(sessionId));
  }

  createSession(sessionId: string): SessionMeta {
    const sessionPath = this.getSessionPath(sessionId);
    
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const meta: SessionMeta = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceDir: this.workspaceDir,
      currentIndex: 0,
      totalSize: 0,
      compressedCount: 0,
    };

    this.saveMeta(sessionId, meta);
    return meta;
  }

  loadMeta(sessionId: string): SessionMeta | undefined {
    const metaPath = this.getMetaFilePath(sessionId);
    
    if (!fs.existsSync(metaPath)) {
      return undefined;
    }

    try {
      const content = fs.readFileSync(metaPath, 'utf-8');
      return JSON.parse(content) as SessionMeta;
    } catch {
      return undefined;
    }
  }

  saveMeta(sessionId: string, meta: SessionMeta): void {
    meta.updatedAt = new Date().toISOString();
    const metaPath = this.getMetaFilePath(sessionId);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }

  appendMessage(sessionId: string, message: PersistedMessage): SessionMeta {
    let meta = this.loadMeta(sessionId);
    
    if (!meta) {
      meta = this.createSession(sessionId);
    }

    const writer = new JSONLWriter(this.getHistoryFilePath(sessionId, meta.currentIndex));
    writer.append(message);

    meta.totalSize += message.content.length;
    this.saveMeta(sessionId, meta);

    return meta;
  }

  appendMessages(sessionId: string, messages: PersistedMessage[]): SessionMeta {
    let meta = this.loadMeta(sessionId);
    
    if (!meta) {
      meta = this.createSession(sessionId);
    }

    const writer = new JSONLWriter(this.getHistoryFilePath(sessionId, meta.currentIndex));
    writer.appendAll(messages);

    const addedSize = messages.reduce((sum, m) => sum + m.content.length, 0);
    meta.totalSize += addedSize;
    this.saveMeta(sessionId, meta);

    return meta;
  }

  loadMessages(sessionId: string): PersistedMessage[] {
    const meta = this.loadMeta(sessionId);
    if (!meta) {
      return [];
    }

    const allMessages: PersistedMessage[] = [];

    for (let i = 0; i <= meta.currentIndex; i++) {
      const writer = new JSONLWriter(this.getHistoryFilePath(sessionId, i));
      const messages = writer.readAll();
      allMessages.push(...messages);
    }

    return allMessages;
  }

  loadLatestMessages(sessionId: string): PersistedMessage[] {
    const meta = this.loadMeta(sessionId);
    if (!meta) {
      return [];
    }

    const writer = new JSONLWriter(this.getHistoryFilePath(sessionId, meta.currentIndex));
    return writer.readAll();
  }

  getCurrentContentSize(sessionId: string): number {
    const meta = this.loadMeta(sessionId);
    if (!meta) {
      return 0;
    }

    const writer = new JSONLWriter(this.getHistoryFilePath(sessionId, meta.currentIndex));
    return writer.getContentSize();
  }

  needsCompression(sessionId: string): boolean {
    if (!this.config.autoCompress) {
      return false;
    }

    const meta = this.loadMeta(sessionId);
    if (!meta) {
      return false;
    }

    return meta.totalSize >= this.config.compressionThreshold;
  }

  startNewHistoryFile(sessionId: string): SessionMeta {
    let meta = this.loadMeta(sessionId);
    
    if (!meta) {
      meta = this.createSession(sessionId);
    }

    meta.currentIndex += 1;
    meta.totalSize = 0;
    this.saveMeta(sessionId, meta);

    return meta;
  }

  saveCompressedHistory(
    sessionId: string, 
    compressedContent: string,
    originalSize: number
  ): SessionMeta {
    let meta = this.loadMeta(sessionId);
    
    if (!meta) {
      meta = this.createSession(sessionId);
    }

    const newIndex = meta.currentIndex + 1;
    const compressedMessage = createPersistedMessage('user', compressedContent, {
      metadata: {
        compressed: true,
        originalSize,
        compressedSize: compressedContent.length,
      },
    });

    const writer = new JSONLWriter(this.getHistoryFilePath(sessionId, newIndex));
    writer.overwrite([compressedMessage]);

    meta.currentIndex = newIndex;
    meta.totalSize = compressedContent.length;
    meta.compressedCount += 1;
    this.saveMeta(sessionId, meta);

    return meta;
  }

  deleteSession(sessionId: string): boolean {
    const sessionPath = this.getSessionPath(sessionId);
    
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      return true;
    }
    
    return false;
  }

  listSessions(): string[] {
    if (!fs.existsSync(this.sessionDir)) {
      return [];
    }

    return fs.readdirSync(this.sessionDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  }

  getConfig(): Required<SessionStorageConfig> {
    return { ...this.config };
  }

  messageToPersisted(msg: Message): PersistedMessage {
    const content = typeof msg.content === 'string' 
      ? msg.content 
      : msg.content.map(b => b.text || '').join('\n');

    return createPersistedMessage(msg.role, content, {
      thinking: msg.thinking,
      toolCalls: msg.toolCalls,
      toolCallId: msg.toolCallId,
      name: msg.name,
    });
  }

  persistedToMessage(pmsg: PersistedMessage): Message {
    return {
      role: pmsg.role,
      content: pmsg.content,
      thinking: pmsg.thinking,
      toolCalls: pmsg.toolCalls,
      toolCallId: pmsg.toolCallId,
      name: pmsg.name,
    };
  }
}
