import * as fs from 'fs';
import * as path from 'path';
import { Tool, successResult, errorResult } from './Tool.js';
import type { ToolResult } from '../types.js';

export interface NoteToolOptions {
  workspaceDir: string;
  notesFile?: string;
}

export class SessionNoteTool extends Tool {
  private notesFile: string;
  private notes: Map<string, string> = new Map();

  constructor(options: NoteToolOptions) {
    super();
    this.notesFile = options.notesFile 
      ?? path.join(options.workspaceDir, '.agent_notes.json');
    this.loadNotes();
  }

  get name(): string {
    return 'session_note';
  }

  get description(): string {
    return 'Manage session notes to persist important information across conversations. Use this to store and retrieve key facts, decisions, or context.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'list', 'delete', 'clear'],
          description: 'The action to perform: get, set, list, delete, or clear.',
        },
        key: {
          type: 'string',
          description: 'The key for the note (used with get, set, delete).',
        },
        value: {
          type: 'string',
          description: 'The value to store (used with set).',
        },
      },
      required: ['action'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;
    const key = args.key as string | undefined;
    const value = args.value as string | undefined;

    switch (action) {
      case 'get':
        return this.getNote(key);
      case 'set':
        return this.setNote(key, value);
      case 'list':
        return this.listNotes();
      case 'delete':
        return this.deleteNote(key);
      case 'clear':
        return this.clearNotes();
      default:
        return errorResult(`Unknown action: ${action}`);
    }
  }

  private getNote(key?: string): ToolResult {
    if (!key) {
      return errorResult('Key is required for get action');
    }

    const value = this.notes.get(key);
    if (value === undefined) {
      return successResult(`Note "${key}" not found`);
    }
    return successResult(value);
  }

  private setNote(key?: string, value?: string): ToolResult {
    if (!key) {
      return errorResult('Key is required for set action');
    }
    if (value === undefined) {
      return errorResult('Value is required for set action');
    }

    this.notes.set(key, value);
    this.saveNotes();
    return successResult(`Note "${key}" saved`);
  }

  private listNotes(): ToolResult {
    if (this.notes.size === 0) {
      return successResult('No notes stored');
    }

    const items = Array.from(this.notes.entries())
      .map(([k, v]) => `${k}: ${v.length > 100 ? v.substring(0, 100) + '...' : v}`)
      .join('\n');
    
    return successResult(`Stored notes (${this.notes.size}):\n${items}`);
  }

  private deleteNote(key?: string): ToolResult {
    if (!key) {
      return errorResult('Key is required for delete action');
    }

    if (this.notes.delete(key)) {
      this.saveNotes();
      return successResult(`Note "${key}" deleted`);
    }
    return successResult(`Note "${key}" not found`);
  }

  private clearNotes(): ToolResult {
    this.notes.clear();
    this.saveNotes();
    return successResult('All notes cleared');
  }

  private loadNotes(): void {
    try {
      if (fs.existsSync(this.notesFile)) {
        const content = fs.readFileSync(this.notesFile, 'utf-8');
        const data = JSON.parse(content);
        for (const [key, value] of Object.entries(data)) {
          this.notes.set(key, value as string);
        }
      }
    } catch {
      // Ignore errors when loading notes
    }
  }

  private saveNotes(): void {
    try {
      const dir = path.dirname(this.notesFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = Object.fromEntries(this.notes);
      fs.writeFileSync(this.notesFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      // Ignore errors when saving notes
    }
  }
}

export function createNoteTool(options: NoteToolOptions): SessionNoteTool {
  return new SessionNoteTool(options);
}
