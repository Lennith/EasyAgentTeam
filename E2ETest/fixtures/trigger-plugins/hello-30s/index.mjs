import fs from "node:fs/promises";
import path from "node:path";

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function appendJsonl(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

export async function doCheck(ctx) {
  await fs.mkdir(ctx.dataDir, { recursive: true });
  const counterFile = path.join(ctx.dataDir, "counter.json");
  const current = await readJson(counterFile, { sequence: 0 });
  const sequence = Number(current.sequence || 0) + 1;
  await fs.writeFile(counterFile, JSON.stringify({ sequence }), "utf8");
  return {
    need_trigger: true,
    reason: `hello trigger sequence ${sequence}`,
    payload: {
      sequence: String(sequence),
      marker: `TRIGGER_HELLO_DONE_${sequence}`
    }
  };
}

export async function onCheckResult(_ctx, result) {
  const sequence = String(result.payload?.sequence || "0");
  const marker = String(result.payload?.marker || `TRIGGER_HELLO_DONE_${sequence}`);
  return {
    should_trigger: true,
    reason: `fire workflow for ${marker}`,
    run_name: `Trigger hello ${sequence}`,
    variables: {
      sequence,
      marker,
      message: `hello ${sequence}`
    },
    task_overrides: {
      say_hello: `Write docs/e2e/trigger_stability_${sequence}.md containing ${marker}, then call TeamTool task_report_done for the active task.`
    },
    auto_dispatch_remaining: 1
  };
}

export async function onWorkflowCompleted(ctx, completion) {
  const accepted = completion.status === "finished";
  await appendJsonl(path.join(ctx.dataDir, "completions.jsonl"), {
    at: new Date().toISOString(),
    run_id: completion.run_id || completion.runId,
    fire_id: completion.fire_id || completion.fireId,
    status: completion.status,
    accepted
  });
  return {
    accepted,
    summary: completion.status,
    reason: accepted ? "workflow finished" : "workflow did not finish"
  };
}
