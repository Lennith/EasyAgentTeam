import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

interface WorkerInput {
  entryPath: string;
  hook: string;
  args: unknown[];
}

async function main(): Promise<void> {
  const input = workerData as WorkerInput;
  const module = (await import(pathToFileURL(input.entryPath).href)) as Record<string, unknown>;
  if (input.hook === "__validate") {
    const doCheck = typeof module.doCheck === "function";
    const onCheckResult = typeof module.onCheckResult === "function";
    parentPort?.postMessage({
      ok: doCheck && onCheckResult,
      result: {
        doCheck,
        onCheckResult,
        hasCompletionHook: typeof module.onWorkflowCompleted === "function"
      },
      error: doCheck && onCheckResult ? null : "trigger plugin must export doCheck and onCheckResult"
    });
    return;
  }
  const hook = module[input.hook];
  if (typeof hook !== "function") {
    parentPort?.postMessage({ ok: false, error: `trigger plugin hook '${input.hook}' is not exported` });
    return;
  }
  const result = await hook(...input.args);
  parentPort?.postMessage({ ok: true, result });
}

main().catch((error: unknown) => {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
});
