import { spawn } from "node:child_process";

const useWatch = process.stdout.isTTY && process.env.AUTO_DEV_NO_WATCH !== "1";
const args = useWatch ? ["watch", "src/index.ts"] : ["src/index.ts"];

const child = spawn("tsx", args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
