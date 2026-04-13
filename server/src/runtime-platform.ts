import path from "node:path";

export type HostPlatform = "win32" | "linux" | "darwin";
export type ShellType = "powershell" | "cmd" | "bash" | "sh";

export interface RuntimePlatformCapabilities {
  platform: HostPlatform;
  label: string;
  isUnixLike: boolean;
  macosUntested: boolean;
  supportedShells: ShellType[];
  defaultShell: ShellType;
  promptBaseline: string;
  agentWorkspaceGuide: string;
  codexCliCommandDefault: string;
}

function normalizeHostPlatform(raw: NodeJS.Platform | string | undefined): HostPlatform {
  if (raw === "linux" || raw === "darwin" || raw === "win32") {
    return raw;
  }
  return "linux";
}

function buildPromptBaseline(platform: HostPlatform): string {
  if (platform === "win32") {
    return [
      "You are running in a Windows environment.",
      "- Use PowerShell/CMD syntax only.",
      "- Do not use bash/sh/zsh syntax.",
      "- Use absolute or clearly resolvable Windows paths when editing files.",
      "- Prefer PowerShell for complex commands and cmd for simple compatibility cases."
    ].join("\n");
  }

  const hostLabel = platform === "darwin" ? "macOS" : "Linux";
  const macNote =
    platform === "darwin"
      ? "- macOS support is design-compatible but not yet fully validated; prefer portable POSIX commands."
      : undefined;

  return [
    `You are running in a ${hostLabel} environment.`,
    "- Use bash/sh syntax only.",
    "- Do not use PowerShell/CMD syntax.",
    "- Use POSIX paths when editing files.",
    "- Prefer bash for complex commands and fall back to sh only when needed.",
    ...(macNote ? [macNote] : [])
  ].join("\n");
}

function buildAgentWorkspaceGuide(platform: HostPlatform): string {
  if (platform === "win32") {
    return [
      "0. YOUR RUNTIME IS WINDOWS. DO NOT USE BASH OR UNIX COMMANDS.",
      "   - Forbidden: ls, cat, grep, rm, mkdir -p, chmod, touch, cp, mv, find, which, export, source, apt, yum, sudo",
      "   - Use PowerShell/CMD: Get-ChildItem, Get-Content, Select-String, Remove-Item, New-Item, Copy-Item, Move-Item, dir, type"
    ].join("\n");
  }

  const hostLabel = platform === "darwin" ? "MACOS" : "LINUX";
  const macNote =
    platform === "darwin"
      ? "   - macOS is design-compatible but not fully validated. Prefer portable POSIX commands over Linux-specific package manager commands."
      : undefined;

  return [
    `0. YOUR RUNTIME IS ${hostLabel}. DO NOT USE POWERSHELL OR CMD COMMANDS.`,
    "   - Forbidden: Get-ChildItem, Get-Content, Select-String, Remove-Item, New-Item, Copy-Item, Move-Item, dir, type, del, taskkill",
    "   - Use POSIX shell commands: ls, cat, grep, rm, mkdir -p, chmod, touch, cp, mv, find, which, export",
    ...(macNote ? [macNote] : [])
  ].join("\n");
}

function defaultCodexCliCommand(platform: HostPlatform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    const appData = env.APPDATA;
    if (appData) {
      return path.join(appData, "npm", "codex.cmd");
    }
  }
  return "codex";
}

export function getRuntimePlatformCapabilities(
  rawPlatform: NodeJS.Platform | string | undefined = process.platform,
  env: NodeJS.ProcessEnv = process.env
): RuntimePlatformCapabilities {
  const platform = normalizeHostPlatform(rawPlatform);
  const supportedShells: ShellType[] = platform === "win32" ? ["powershell", "cmd"] : ["bash", "sh"];
  const defaultShell: ShellType = platform === "win32" ? "powershell" : "bash";

  return {
    platform,
    label: platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : "Linux",
    isUnixLike: platform !== "win32",
    macosUntested: platform === "darwin",
    supportedShells,
    defaultShell,
    promptBaseline: buildPromptBaseline(platform),
    agentWorkspaceGuide: buildAgentWorkspaceGuide(platform),
    codexCliCommandDefault: defaultCodexCliCommand(platform, env)
  };
}

export function getSupportedShellTypes(
  rawPlatform: NodeJS.Platform | string | undefined = process.platform
): ShellType[] {
  return getRuntimePlatformCapabilities(rawPlatform).supportedShells;
}

export function getDefaultShellType(rawPlatform: NodeJS.Platform | string | undefined = process.platform): ShellType {
  return getRuntimePlatformCapabilities(rawPlatform).defaultShell;
}

export function isShellSupportedOnPlatform(
  shell: ShellType,
  rawPlatform: NodeJS.Platform | string | undefined = process.platform
): boolean {
  return getSupportedShellTypes(rawPlatform).includes(shell);
}

export function coerceShellTypeForPlatform(
  shell: ShellType | undefined,
  rawPlatform: NodeJS.Platform | string | undefined = process.platform
): ShellType {
  if (shell && isShellSupportedOnPlatform(shell, rawPlatform)) {
    return shell;
  }
  return getDefaultShellType(rawPlatform);
}
