import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
// Go up 4 levels: logger.ts -> utils -> src -> server -> root
const LOGS_DIR = join(dirname(dirname(dirname(dirname(__filename)))), "logs");

// Ensure logs directory exists
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

function getDateString(): string {
  // Use local timezone instead of UTC
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatMessage(level: string, message: string): string {
  return `[${getDateString()}] [${level}] ${message}\n`;
}

class Logger {
  private infoStream: ReturnType<typeof createWriteStream>;
  private errorStream: ReturnType<typeof createWriteStream>;
  private warnStream: ReturnType<typeof createWriteStream>;
  private processStream: ReturnType<typeof createWriteStream>;
  private minimaxStream: ReturnType<typeof createWriteStream>;

  private infoPath: string;
  private errorPath: string;
  private warnPath: string;
  private processPath: string;
  private minimaxPath: string;

  private pendingRecreate: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor() {
    this.infoPath = join(LOGS_DIR, "info.log");
    this.errorPath = join(LOGS_DIR, "error.log");
    this.warnPath = join(LOGS_DIR, "warn.log");
    this.processPath = join(LOGS_DIR, "process.log");
    this.minimaxPath = join(LOGS_DIR, "minimax.log");

    this.infoStream = createWriteStream(this.infoPath, { flags: "a" });
    this.errorStream = createWriteStream(this.errorPath, { flags: "a" });
    this.warnStream = createWriteStream(this.warnPath, { flags: "a" });
    this.processStream = createWriteStream(this.processPath, { flags: "a" });
    this.minimaxStream = createWriteStream(this.minimaxPath, { flags: "a" });
  }

  private ensureStream(path: string, stream: ReturnType<typeof createWriteStream>, name: string): ReturnType<typeof createWriteStream> {
    try {
      // Check if file still exists
      statSync(path);
      return stream;
    } catch {
      // File was deleted, schedule recreate after 5 seconds
      if (!this.pendingRecreate.has(name)) {
        console.error(`[logger] ${name}.log was deleted, will recreate in 5s...`);
        const timer = setTimeout(() => {
          this.pendingRecreate.delete(name);
          console.error(`[logger] recreating ${name}.log stream...`);
          if (name === 'info') this.infoStream = createWriteStream(this.infoPath, { flags: "a" });
          if (name === 'error') this.errorStream = createWriteStream(this.errorPath, { flags: "a" });
          if (name === 'warn') this.warnStream = createWriteStream(this.warnPath, { flags: "a" });
          if (name === 'process') this.processStream = createWriteStream(this.processPath, { flags: "a" });
          if (name === 'minimax') this.minimaxStream = createWriteStream(this.minimaxPath, { flags: "a" });
        }, 5000);
        this.pendingRecreate.set(name, timer);
      }
      return stream;
    }
  }

  info(message: string): void {
    const formatted = formatMessage("INFO", message);
    process.stdout.write(formatted);
    this.infoStream = this.ensureStream(this.infoPath, this.infoStream, 'info');
    this.infoStream.write(formatted);
  }

  error(message: string): void {
    const formatted = formatMessage("ERROR", message);
    process.stderr.write(formatted);
    this.errorStream = this.ensureStream(this.errorPath, this.errorStream, 'error');
    this.errorStream.write(formatted);
  }

  warn(message: string): void {
    const formatted = formatMessage("WARN", message);
    process.stderr.write(formatted);
    this.warnStream = this.ensureStream(this.warnPath, this.warnStream, 'warn');
    this.warnStream.write(formatted);
  }

  process(message: string): void {
    const formatted = formatMessage("PROCESS", message);
    process.stdout.write(formatted);
    this.processStream = this.ensureStream(this.processPath, this.processStream, 'process');
    this.processStream.write(formatted);
  }

  minimax(message: string): void {
    const formatted = formatMessage("MINIMAX", message);
    process.stdout.write(formatted);
    this.minimaxStream = this.ensureStream(this.minimaxPath, this.minimaxStream, 'minimax');
    this.minimaxStream.write(formatted);
  }

  close(): void {
    // Clear all pending recreate timers
    for (const timer of this.pendingRecreate.values()) {
      clearTimeout(timer);
    }
    this.pendingRecreate.clear();

    this.infoStream.end();
    this.errorStream.end();
    this.warnStream.end();
    this.processStream.end();
    this.minimaxStream.end();
  }
}

export const logger = new Logger();
