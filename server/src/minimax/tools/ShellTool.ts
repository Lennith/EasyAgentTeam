import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { Tool, successResult, errorResult } from "./Tool.js";
import type { ToolResult, ShellType, PermissionCheckResult } from "../types.js";
import { logger } from "../../utils/logger.js";
import {
  coerceShellTypeForPlatform,
  getDefaultShellType,
  getRuntimePlatformCapabilities,
  isShellSupportedOnPlatform
} from "../../runtime-platform.js";

// Process tracking log file path
function logProcessEvent(event: "spawn" | "kill" | "exit", pid: number, command: string, details?: string): void {
  const logMessage = `[${event.toUpperCase()}] pid=${pid}, command="${command.slice(0, 100)}..."${details ? `, ${details}` : ""}`;
  logger.process(logMessage);
}

export interface ShellToolOptions {
  workspaceDir: string;
  shell?: ShellType;
  timeout?: number;
  outputIdleTimeout?: number;
  maxRunTime?: number;
  maxOutputSize?: number;
  logDir?: string;
  additionalWritableDirs?: string[];
  checkPermission?: (filePath: string, operation: "read" | "write") => PermissionCheckResult;
  env?: Record<string, string>;
}

interface ShellExecutionLog {
  logId: string;
  timestamp: string;
  pid: number | undefined;
  command: string;
  shellType: ShellType;
  cwd: string;
  timeout: number;
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  outputSize: number;
  killed: boolean;
  killReason: string | null;
}

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_OUTPUT_IDLE_TIMEOUT = 120 * 1000;
const DEFAULT_MAX_RUN_TIME = 60 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_SIZE = 50 * 1024 * 1024;

export class ShellTool extends Tool {
  private workspaceDir: string;
  private defaultShell: ShellType;
  private defaultTimeout: number;
  private outputIdleTimeout: number;
  private maxRunTime: number;
  private maxOutputSize: number;
  private logDir: string;
  private checkPermission?: (filePath: string, operation: "read" | "write") => PermissionCheckResult;
  private extraEnv: Record<string, string>;
  private activeProcesses: Map<number, ReturnType<typeof spawn>> = new Map();

  constructor(options: ShellToolOptions) {
    super();
    this.workspaceDir = options.workspaceDir;
    this.defaultShell = coerceShellTypeForPlatform(options.shell);
    this.defaultTimeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.outputIdleTimeout = options.outputIdleTimeout ?? DEFAULT_OUTPUT_IDLE_TIMEOUT;
    this.maxRunTime = options.maxRunTime ?? DEFAULT_MAX_RUN_TIME;
    this.maxOutputSize = options.maxOutputSize ?? DEFAULT_MAX_OUTPUT_SIZE;
    this.logDir = options.logDir ?? path.join(options.workspaceDir, ".minimax", "shell-logs");
    this.checkPermission = options.checkPermission;
    this.extraEnv = options.env ?? {};
  }

  get name(): string {
    return "shell_execute";
  }

  get description(): string {
    const runtime = getRuntimePlatformCapabilities();
    return `Execute shell commands on ${runtime.label} using ${runtime.supportedShells.join("/")} shells. Use with caution.`;
  }

  get parameters(): Record<string, unknown> {
    const runtime = getRuntimePlatformCapabilities();
    return {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command to execute."
        },
        shell: {
          type: "string",
          enum: runtime.supportedShells,
          description: `The shell to use. Default is ${this.defaultShell}.`
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds. Default is 30000."
        },
        cwd: {
          type: "string",
          description: "Working directory for the command. Default is workspace root."
        }
      },
      required: ["command"]
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const command = args.command as string;
    const requestedShell = args.shell as ShellType | undefined;
    if (requestedShell && !isShellSupportedOnPlatform(requestedShell)) {
      const runtime = getRuntimePlatformCapabilities();
      return errorResult(
        `Shell '${requestedShell}' is not available on ${runtime.label}. Supported shells: ${runtime.supportedShells.join(", ")}`
      );
    }
    const shell = coerceShellTypeForPlatform(requestedShell ?? this.defaultShell);
    const timeout = (args.timeout as number) ?? this.defaultTimeout;
    const cwd = this.resolvePath((args.cwd as string) ?? ".");

    if (this.checkPermission) {
      const perm = this.checkPermission(cwd, "read");
      if (!perm.allowed) {
        return errorResult(perm.reason ?? "Permission denied");
      }
    }

    return this.executeCommand(command, shell, cwd, timeout);
  }

  private resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve(this.workspaceDir, p);
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private async appendLog(log: ShellExecutionLog): Promise<void> {
    try {
      this.ensureLogDir();
      const logFile = path.join(this.logDir, `${log.logId}.jsonl`);
      const logLine = JSON.stringify(log) + "\n";
      await fs.promises.appendFile(logFile, logLine);
      logger.info(
        `[ShellTool] Logged shell execution: pid=${log.pid}, command="${log.command.slice(0, 50)}...", exitCode=${log.exitCode}, killed=${log.killed}, logFile=${logFile}`
      );
    } catch (err) {
      logger.error(`[ShellTool] Failed to write log: ${(err as Error).message}`);
    }
  }

  private killProcessTree(pid: number): void {
    if (process.platform === "win32") {
      logProcessEvent("kill", pid, "taskkill", "killing process tree");

      const killProc = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "pipe"
      });

      const killPid = killProc.pid;
      if (killPid) {
        this.activeProcesses.set(killPid, killProc);
      }

      const killTimeout = setTimeout(() => {
        if (!killProc.killed) {
          killProc.kill();
        }
      }, 5000);

      killProc.on("error", (err) => {
        clearTimeout(killTimeout);
        if (killPid) {
          this.activeProcesses.delete(killPid);
        }
        logger.error(`[ShellTool] Failed to kill process tree ${pid}: ${err.message}`);
      });

      killProc.on("close", (code) => {
        clearTimeout(killTimeout);
        if (killPid) {
          this.activeProcesses.delete(killPid);
        }
        if (code !== 0) {
          logger.error(`[ShellTool] taskkill for pid ${pid} exited with code ${code}`);
        }
      });
      return;
    }

    try {
      logProcessEvent("kill", pid, "process.kill", "killing POSIX process group");
      process.kill(-pid, "SIGKILL");
    } catch (err) {
      logger.error(`[ShellTool] Failed to kill POSIX process group ${pid}: ${(err as Error).message}`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore fallback failure
      }
    }
  }

  private executeCommand(command: string, shell: ShellType, cwd: string, timeout: number): Promise<ToolResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let resolved = false;
      let lastOutputTime = Date.now();
      let stdoutTruncated = false;
      let stderrTruncated = false;

      const logId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      const startedAt = new Date().toISOString();

      const shellArgs = this.getShellArgs(shell, command);
      const shellCmd = this.getShellCommand(shell);

      const env = {
        ...process.env,
        ...this.extraEnv
      };

      const proc = spawn(shellCmd, shellArgs, {
        cwd,
        env,
        shell: false,
        windowsHide: process.platform === "win32",
        detached: process.platform !== "win32"
      });

      const pid = proc.pid;

      // Track active process for cleanup
      if (pid) {
        this.activeProcesses.set(pid, proc);
        logProcessEvent("spawn", pid, command);
      }

      const log: ShellExecutionLog = {
        logId,
        timestamp: startedAt,
        pid,
        command,
        shellType: shell,
        cwd,
        timeout,
        startedAt,
        exitCode: null,
        outputSize: 0,
        killed: false,
        killReason: null
      };

      const cleanup = (reason: string | null, exitCode: number | null = null) => {
        if (resolved) return;
        resolved = true;

        clearInterval(outputIdleTimer);
        clearTimeout(maxRunTimer);
        clearTimeout(commandTimer);

        // Remove from active processes
        if (pid) {
          this.activeProcesses.delete(pid);
          logProcessEvent("exit", pid, command, `reason=${reason}, exitCode=${exitCode}`);
        }

        if (pid && !proc.killed && proc.exitCode === null) {
          this.killProcessTree(pid);
        }

        log.finishedAt = new Date().toISOString();
        log.outputSize = stdout.length + stderr.length;
        log.killed = reason !== null;
        log.killReason = reason;
        log.exitCode = exitCode;

        this.appendLog(log).catch(() => {});
      };

      const outputIdleTimer = setInterval(() => {
        if (Date.now() - lastOutputTime > this.outputIdleTimeout) {
          cleanup("output_idle_timeout");
          resolve(errorResult(`Process killed: no output for ${this.outputIdleTimeout / 1000} seconds`));
        }
      }, 5000);

      const maxRunTimer = setTimeout(() => {
        cleanup("max_runtime_exceeded");
        resolve(errorResult(`Process killed: exceeded maximum runtime of ${this.maxRunTime / 1000} seconds`));
      }, this.maxRunTime);

      const commandTimer = setTimeout(() => {
        cleanup("command_timeout");
        resolve(errorResult(`Command timed out after ${timeout}ms`));
      }, timeout);

      proc.stdout.on("data", (data) => {
        lastOutputTime = Date.now();
        if (!stdoutTruncated && stdout.length < this.maxOutputSize) {
          const newData = data.toString();
          if (stdout.length + newData.length <= this.maxOutputSize) {
            stdout += newData;
          } else {
            stdout += newData.slice(0, this.maxOutputSize - stdout.length);
            stdoutTruncated = true;
            stdout += "\n[OUTPUT TRUNCATED - exceeded 50MB limit]";
          }
        }
      });

      proc.stderr.on("data", (data) => {
        lastOutputTime = Date.now();
        if (!stderrTruncated && stderr.length < this.maxOutputSize) {
          const newData = data.toString();
          if (stderr.length + newData.length <= this.maxOutputSize) {
            stderr += newData;
          } else {
            stderr += newData.slice(0, this.maxOutputSize - stderr.length);
            stderrTruncated = true;
            stderr += "\n[OUTPUT TRUNCATED - exceeded 50MB limit]";
          }
        }
      });

      proc.on("close", (code) => {
        if (resolved) return;

        cleanup(null, code);

        if (code === 0) {
          resolve(successResult(stdout.trim() || "(no output)"));
        } else {
          resolve(errorResult(`Command exited with code ${code}\nStdout: ${stdout}\nStderr: ${stderr}`));
        }
      });

      proc.on("error", (err) => {
        if (resolved) return;

        cleanup("spawn_error", -1);
        resolve(errorResult(`Failed to execute command: ${err.message}`));
      });
    });
  }

  /**
   * Cleanup all active processes. Called by MiniMaxAgent.cleanup() to prevent
   * memory leaks when agent session ends.
   */
  cleanupAll(): void {
    const activePids = Array.from(this.activeProcesses.keys());
    if (activePids.length === 0) {
      return;
    }

    logger.info(`[ShellTool] cleanupAll: killing ${activePids.length} active processes: ${activePids.join(", ")}`);
    logProcessEvent("kill", 0, "cleanupAll", `killing ${activePids.length} processes: ${activePids.join(", ")}`);

    for (const pid of activePids) {
      const proc = this.activeProcesses.get(pid);
      if (proc && !proc.killed) {
        try {
          this.killProcessTree(pid);
          logProcessEvent("kill", pid, "cleanupAll", "killed by cleanupAll");
        } catch (err) {
          logger.error(`[ShellTool] Failed to kill process ${pid}: ${(err as Error).message}`);
        }
      }
      this.activeProcesses.delete(pid);
    }
  }

  private getShellCommand(shell: ShellType): string {
    switch (shell) {
      case "powershell":
        return "powershell.exe";
      case "cmd":
        return "cmd.exe";
      case "bash":
        return "bash";
      case "sh":
        return "sh";
      default:
        return this.getShellCommand(getDefaultShellType());
    }
  }

  private getShellArgs(shell: ShellType, command: string): string[] {
    switch (shell) {
      case "powershell":
        return ["-NoProfile", "-NonInteractive", "-Command", command];
      case "cmd":
        return ["/c", command];
      case "bash":
        return ["-lc", command];
      case "sh":
        return ["-c", command];
      default:
        return this.getShellArgs(this.defaultShell, command);
    }
  }
}

export function createShellTool(options: ShellToolOptions): ShellTool {
  return new ShellTool(options);
}
