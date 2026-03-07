import * as fs from "fs";
import * as path from "path";
import { Tool, successResult, errorResult } from "./Tool.js";
import type { ToolResult, PermissionCheckResult } from "../types.js";

export interface FileToolsOptions {
  workspaceDir: string;
  additionalWritableDirs?: string[];
  checkPermission?: (filePath: string, operation: "read" | "write") => PermissionCheckResult;
}

export class ReadFileTool extends Tool {
  private workspaceDir: string;
  private checkPermission?: (filePath: string, operation: "read" | "write") => PermissionCheckResult;

  constructor(options: FileToolsOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
  }

  get name(): string {
    return "read_file";
  }

  get description(): string {
    return "Read the contents of a file. Returns the file content as a string.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the file to read. Can be absolute or relative to workspace."
        },
        offset: {
          type: "number",
          description: "Optional line offset (number of lines to skip from start).",
          default: 0
        },
        limit: {
          type: "number",
          description: "Optional max number of lines to return after offset."
        },
        encoding: {
          type: "string",
          description: "The encoding to use. Default is utf-8.",
          default: "utf-8"
        }
      },
      required: ["path"]
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.resolvePath(args.path as string);
    const encoding = (args.encoding as BufferEncoding) ?? "utf-8";
    const offset = this.readInteger(args.offset, 0);
    const limit = this.readInteger(args.limit, undefined);

    if (this.checkPermission) {
      const perm = this.checkPermission(filePath, "read");
      if (!perm.allowed) {
        return errorResult(perm.reason ?? "Permission denied");
      }
    }

    if (!fs.existsSync(filePath)) {
      return errorResult(`File not found: ${filePath}`);
    }

    try {
      const content = fs.readFileSync(filePath, encoding);
      if ((offset ?? 0) > 0 || limit !== undefined) {
        const normalized = content.replace(/\r\n/g, "\n");
        const lines = normalized.split("\n");
        const start = Math.max(0, offset ?? 0);
        const sliced = limit === undefined ? lines.slice(start) : lines.slice(start, start + Math.max(0, limit));
        return successResult(sliced.join("\n"));
      }
      return successResult(content);
    } catch (err) {
      return errorResult(`Failed to read file: ${err}`);
    }
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }

  private readInteger(value: unknown, fallback: number | undefined): number | undefined {
    if (value === undefined || value === null) {
      return fallback;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.floor(parsed));
      }
    }
    return fallback;
  }
}

export class WriteFileTool extends Tool {
  private workspaceDir: string;
  private checkPermission?: (filePath: string, operation: "read" | "write") => PermissionCheckResult;

  constructor(options: FileToolsOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
  }

  get name(): string {
    return "write_file";
  }

  get description(): string {
    return "Write content to a file. Creates the file if it does not exist, overwrites if it does.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the file to write. Can be absolute or relative to workspace."
        },
        content: {
          type: "string",
          description: "The content to write to the file."
        },
        encoding: {
          type: "string",
          description: "The encoding to use. Default is utf-8.",
          default: "utf-8"
        }
      },
      required: ["path", "content"]
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.resolvePath(args.path as string);
    const content = args.content as string;
    const encoding = (args.encoding as BufferEncoding) ?? "utf-8";

    if (this.checkPermission) {
      const perm = this.checkPermission(filePath, "write");
      if (!perm.allowed) {
        return errorResult(perm.reason ?? "Permission denied");
      }
    }

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, content, encoding);
      return successResult(`Successfully wrote ${content.length} characters to ${filePath}`);
    } catch (err) {
      return errorResult(`Failed to write file: ${err}`);
    }
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }
}

export class EditFileTool extends Tool {
  private workspaceDir: string;
  private checkPermission?: (filePath: string, operation: "read" | "write") => PermissionCheckResult;

  constructor(options: FileToolsOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
  }

  get name(): string {
    return "edit_file";
  }

  get description(): string {
    return "Edit a file by replacing a specific string with a new string.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the file to edit."
        },
        oldStr: {
          type: "string",
          description: "The text to search for and replace."
        },
        newStr: {
          type: "string",
          description: "The text to replace with."
        }
      },
      required: ["path", "oldStr", "newStr"]
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.resolvePath(args.path as string);
    const oldStr = args.oldStr as string;
    const newStr = args.newStr as string;

    if (this.checkPermission) {
      const perm = this.checkPermission(filePath, "write");
      if (!perm.allowed) {
        return errorResult(perm.reason ?? "Permission denied");
      }
    }

    if (!fs.existsSync(filePath)) {
      return errorResult(`File not found: ${filePath}`);
    }

    try {
      let content = fs.readFileSync(filePath, "utf-8");

      if (!content.includes(oldStr)) {
        return errorResult(`Text not found in file: "${oldStr.substring(0, 100)}..."`);
      }

      const newContent = content.replace(oldStr, newStr);
      fs.writeFileSync(filePath, newContent, "utf-8");

      return successResult(`Successfully edited ${filePath}`);
    } catch (err) {
      return errorResult(`Failed to edit file: ${err}`);
    }
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }
}

export class ListDirectoryTool extends Tool {
  private workspaceDir: string;
  private checkPermission?: (filePath: string, operation: "read" | "write") => PermissionCheckResult;

  constructor(options: FileToolsOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
  }

  get name(): string {
    return "list_directory";
  }

  get description(): string {
    return "List the contents of a directory.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the directory to list. Default is workspace root."
        }
      },
      required: []
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const dirPath = this.resolvePath((args.path as string) ?? ".");

    if (this.checkPermission) {
      const perm = this.checkPermission(dirPath, "read");
      if (!perm.allowed) {
        return errorResult(perm.reason ?? "Permission denied");
      }
    }

    if (!fs.existsSync(dirPath)) {
      return errorResult(`Directory not found: ${dirPath}`);
    }

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = entries.map((entry) => {
        const type = entry.isDirectory() ? "DIR" : "FILE";
        return `${type}\t${entry.name}`;
      });

      return successResult(items.join("\n") || "(empty directory)");
    } catch (err) {
      return errorResult(`Failed to list directory: ${err}`);
    }
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }
}

export class GlobTool extends Tool {
  private workspaceDir: string;
  private checkPermission?: (filePath: string, operation: "read" | "write") => PermissionCheckResult;

  constructor(options: FileToolsOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
  }

  get name(): string {
    return "glob";
  }

  get description(): string {
    return "Find files matching a glob pattern.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: 'The glob pattern to match files. Example: "**/*.ts"'
        },
        path: {
          type: "string",
          description: "The base directory to search from. Default is workspace root."
        }
      },
      required: ["pattern"]
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const basePath = this.resolvePath((args.path as string) ?? ".");

    if (this.checkPermission) {
      const perm = this.checkPermission(basePath, "read");
      if (!perm.allowed) {
        return errorResult(perm.reason ?? "Permission denied");
      }
    }

    try {
      const matches = this.globSearch(basePath, pattern);
      return successResult(matches.join("\n") || "No matches found");
    } catch (err) {
      return errorResult(`Failed to search: ${err}`);
    }
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }

  private globSearch(basePath: string, pattern: string): string[] {
    const results: string[] = [];
    const regex = this.globToRegex(pattern);

    const search = (dir: string) => {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(basePath, fullPath);

        if (entry.isDirectory()) {
          search(fullPath);
        }

        if (regex.test(relativePath.replace(/\\/g, "/"))) {
          results.push(relativePath);
        }
      }
    };

    search(basePath);
    return results;
  }

  private globToRegex(pattern: string): RegExp {
    let regex = pattern
      .replace(/\*\*/g, "<<DOUBLESTAR>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<DOUBLESTAR>>/g, ".*")
      .replace(/\?/g, "[^/]")
      .replace(/\./g, "\\.");

    return new RegExp(`^${regex}$`, "i");
  }
}

export class GrepTool extends Tool {
  private workspaceDir: string;
  private checkPermission?: (filePath: string, operation: "read" | "write") => PermissionCheckResult;

  constructor(options: FileToolsOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.checkPermission = options.checkPermission;
  }

  get name(): string {
    return "grep";
  }

  get description(): string {
    return "Search text content across files and return matching lines with file path and line number.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Search pattern. Interpreted as JavaScript regular expression."
        },
        path: {
          type: "string",
          description: "Base directory to search from. Default is workspace root."
        },
        include: {
          type: ["array", "string"],
          description: 'Optional glob-like include filters (example: "*.ts" or ["*.ts","*.md"]).'
        },
        max_results: {
          type: "number",
          description: "Maximum number of matched lines to return. Default 200.",
          default: 200
        }
      },
      required: ["pattern"]
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const patternRaw = String(args.pattern ?? "").trim();
    if (!patternRaw) {
      return errorResult("pattern is required");
    }
    let regex: RegExp;
    try {
      regex = new RegExp(patternRaw, "i");
    } catch (err) {
      return errorResult(`Invalid regex pattern: ${err}`);
    }
    const basePath = this.resolvePath((args.path as string) ?? ".");
    if (this.checkPermission) {
      const perm = this.checkPermission(basePath, "read");
      if (!perm.allowed) {
        return errorResult(perm.reason ?? "Permission denied");
      }
    }
    const includePatterns = this.normalizeIncludePatterns(args.include);
    const maxResults = this.readInteger(args.max_results, 200);
    const rows: string[] = [];
    const files = this.collectFiles(basePath);

    for (const filePath of files) {
      if (rows.length >= maxResults) {
        break;
      }
      const relativePath = path.relative(basePath, filePath).replace(/\\/g, "/");
      if (!this.matchesInclude(relativePath, includePatterns)) {
        continue;
      }
      let content = "";
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const lines = content.replace(/\r\n/g, "\n").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (regex.test(lines[i])) {
          rows.push(`${relativePath}:${i + 1}:${lines[i]}`);
          if (rows.length >= maxResults) {
            break;
          }
        }
      }
    }

    return successResult(rows.join("\n") || "No matches found");
  }

  private normalizeIncludePatterns(input: unknown): string[] {
    if (Array.isArray(input)) {
      return input.map((item) => String(item).trim()).filter((item) => item.length > 0);
    }
    if (typeof input === "string" && input.trim().length > 0) {
      return input
        .split(/[,\n\r|]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    return [];
  }

  private matchesInclude(relativePath: string, includePatterns: string[]): boolean {
    if (includePatterns.length === 0) {
      return true;
    }
    return includePatterns.some((pattern) => this.globToRegex(pattern).test(relativePath));
  }

  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "<<DOUBLESTAR>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<DOUBLESTAR>>/g, ".*")
      .replace(/\?/g, "[^/]");
    return new RegExp(`^${escaped}$`, "i");
  }

  private collectFiles(basePath: string): string[] {
    const files: string[] = [];
    const stack = [basePath];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || !fs.existsSync(current)) {
        continue;
      }
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === ".git" || entry.name === "node_modules") {
            continue;
          }
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }
    return files;
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }

  private readInteger(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(1, Math.floor(value));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return Math.max(1, Math.floor(parsed));
      }
    }
    return fallback;
  }
}

export class WebFetchTool extends Tool {
  get name(): string {
    return "web_fetch";
  }

  get description(): string {
    return "Fetch a URL and return page content (text/json/markdown).";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "HTTP/HTTPS URL to fetch."
        },
        format: {
          type: "string",
          description: "Response format: text | json | markdown",
          default: "text"
        },
        timeout_ms: {
          type: "number",
          description: "Request timeout in milliseconds. Default 10000.",
          default: 10000
        }
      },
      required: ["url"]
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = String(args.url ?? "").trim();
    if (!url) {
      return errorResult("url is required");
    }
    const format = String(args.format ?? "text")
      .trim()
      .toLowerCase();
    const timeoutMs = this.readInteger(args.timeout_ms, 10000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
      if (!response.ok) {
        return errorResult(`HTTP ${response.status}: ${response.statusText}`);
      }
      if (format === "json" || contentType.includes("application/json")) {
        const data = await response.json();
        return successResult(this.safeText(JSON.stringify(data, null, 2), 12000));
      }
      const text = await response.text();
      if (format === "markdown") {
        const markdown = `# ${url}\n\n\`\`\`\n${this.safeText(text, 12000)}\n\`\`\``;
        return successResult(markdown);
      }
      return successResult(this.safeText(text, 12000));
    } catch (err) {
      return errorResult(`Failed to fetch url: ${err}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private readInteger(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(1000, Math.floor(value));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return Math.max(1000, Math.floor(parsed));
      }
    }
    return fallback;
  }

  private safeText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
  }
}

export class WebSearchTool extends Tool {
  get name(): string {
    return "web_search";
  }

  get description(): string {
    return "Search web content and return brief result snippets.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query."
        },
        num_results: {
          type: "number",
          description: "Number of results to return. Default 5.",
          default: 5
        }
      },
      required: ["query"]
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return errorResult("query is required");
    }
    const numResults = this.readInteger(args.num_results, 5);
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return errorResult(`Search request failed: HTTP ${response.status}`);
      }
      const data = (await response.json()) as Record<string, unknown>;
      const rows: Array<{ title: string; url: string; snippet: string }> = [];
      const abstractText = typeof data.AbstractText === "string" ? data.AbstractText : "";
      const abstractUrl = typeof data.AbstractURL === "string" ? data.AbstractURL : "";
      if (abstractText || abstractUrl) {
        rows.push({
          title: "Instant Answer",
          url: abstractUrl,
          snippet: abstractText
        });
      }
      const relatedTopics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
      for (const topic of relatedTopics) {
        if (rows.length >= numResults) {
          break;
        }
        if (!topic || typeof topic !== "object") {
          continue;
        }
        const row = topic as Record<string, unknown>;
        const text = typeof row.Text === "string" ? row.Text : "";
        const firstUrl = typeof row.FirstURL === "string" ? row.FirstURL : "";
        if (text || firstUrl) {
          rows.push({
            title: this.buildTitleFromText(text),
            url: firstUrl,
            snippet: text
          });
        }
      }
      const resultRows = rows.slice(0, numResults);
      if (resultRows.length === 0) {
        return successResult("No search results found");
      }
      const content = resultRows
        .map((item, idx) => `${idx + 1}. ${item.title}\nURL: ${item.url}\n${item.snippet}`)
        .join("\n\n");
      return successResult(content);
    } catch (err) {
      return errorResult(`Failed to search web: ${err}`);
    }
  }

  private readInteger(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(1, Math.min(20, Math.floor(value)));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return Math.max(1, Math.min(20, Math.floor(parsed)));
      }
    }
    return fallback;
  }

  private buildTitleFromText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) {
      return "Search Result";
    }
    if (trimmed.length <= 80) {
      return trimmed;
    }
    return `${trimmed.slice(0, 80)}...`;
  }
}

export function createFileTools(options: FileToolsOptions): Tool[] {
  return [
    new ReadFileTool(options),
    new WriteFileTool(options),
    new EditFileTool(options),
    new ListDirectoryTool(options),
    new GlobTool(options),
    new GrepTool(options),
    new WebFetchTool(),
    new WebSearchTool()
  ];
}
