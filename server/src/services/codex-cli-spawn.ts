import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

interface CodexSpawnSpec {
  command: string;
  args: string[];
  shell: boolean;
}

export function buildCodexSpawnSpec(command: string, args: string[], env?: NodeJS.ProcessEnv): CodexSpawnSpec {
  if (process.platform !== "win32") {
    return {
      command,
      args,
      shell: false
    };
  }

  const comSpec =
    env?.ComSpec?.trim() ||
    env?.COMSPEC?.trim() ||
    process.env.ComSpec?.trim() ||
    process.env.COMSPEC?.trim() ||
    "C:\\Windows\\System32\\cmd.exe";

  return {
    command: comSpec,
    args: ["/d", "/c", "call", command, ...args],
    shell: false
  };
}

export function spawnCodexProcess(
  command: string,
  args: string[],
  options: Omit<SpawnOptionsWithoutStdio, "shell"> = {}
): ChildProcessWithoutNullStreams {
  const spec = buildCodexSpawnSpec(command, args, options.env);
  return spawn(spec.command, spec.args, {
    ...options,
    shell: spec.shell
  });
}
