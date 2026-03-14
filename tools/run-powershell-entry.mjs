import { spawn } from "node:child_process";
import path from "node:path";

const [, , scriptArg, ...forwardArgs] = process.argv;

if (!scriptArg) {
  console.error("[run-powershell-entry] Missing .ps1 script path.");
  process.exit(1);
}

const scriptPath = path.resolve(process.cwd(), scriptArg);

if (process.platform !== "win32") {
  console.error(
    `[run-powershell-entry] ${path.basename(scriptPath)} is currently Windows-only. ` +
      "The main product runtime is cross-platform, but this PowerShell workflow has not been ported yet."
  );
  process.exit(1);
}

const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...forwardArgs], {
  stdio: "inherit",
  shell: false,
  windowsHide: true
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`[run-powershell-entry] Failed to start PowerShell: ${error.message}`);
  process.exit(1);
});
