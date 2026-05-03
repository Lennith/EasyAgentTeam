import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const scenarioPath = path.join(repoRoot, "E2ETest", "scenarios", "workflow-gesture-mix-dpagent.json");
const runnerPath = path.join(repoRoot, "E2ETest", "scripts", "run-workflow-mix-dpagent-e2e.ps1");
const packagePath = path.join(repoRoot, "package.json");

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sorted(items) {
  return [...items].sort((a, b) => a.localeCompare(b));
}

function assertEqualArray(actual, expected, label) {
  const actualSorted = sorted(actual);
  const expectedSorted = sorted(expected);
  assert(
    actualSorted.length === expectedSorted.length &&
      actualSorted.every((item, index) => item === expectedSorted[index]),
    `${label} expected ${expectedSorted.join(",")} but got ${actualSorted.join(",")}`
  );
}

assert(fs.existsSync(scenarioPath), `Missing workflow mix DPAgent scenario: ${scenarioPath}`);
assert(fs.existsSync(runnerPath), `Missing workflow mix DPAgent runner: ${runnerPath}`);

const scenario = readJson(scenarioPath);
assert(scenario.scenario_id === "workflow_gesture_mix_dpagent_v1", "Unexpected workflow mix DPAgent scenario_id");
assertEqualArray(scenario.expected_providers ?? [], ["dpagent", "minimax"], "expected_providers");

const roles = scenario.roles ?? {};
const roleKeys = Object.keys(roles);
const matrix = scenario.agent_model_matrix ?? {};
assert(roleKeys.length >= 10, "Workflow mix DPAgent scenario should retain the full workflow role set");
for (const roleKey of roleKeys) {
  assert(matrix[roleKey], `agent_model_matrix is missing role key '${roleKey}'`);
}

const providers = new Set(
  Object.values(matrix).map((entry) =>
    String(entry.provider_id ?? "")
      .trim()
      .toLowerCase()
  )
);
assertEqualArray([...providers], ["dpagent", "minimax"], "agent_model_matrix providers");

for (const roleKey of ["product_owner", "android_dev", "qa_engineer"]) {
  assert(matrix[roleKey]?.provider_id === "dpagent", `${roleKey} must use dpagent`);
  assert(matrix[roleKey]?.model === "dpagent-config", `${roleKey} must leave model selection to DPAgent config`);
}

const engineeringTask = (scenario.phase_tasks ?? []).find((task) => task.task_id === "wf_engineering_execution");
const engineeringAcceptance = (engineeringTask?.acceptance ?? []).join("\n");
assert(
  engineeringAcceptance.includes("task_report_in_progress"),
  "Android DPAgent task must require early TeamTool progress"
);
assert(engineeringAcceptance.includes("bounded evidence"), "Android DPAgent task must bound Gradle/build validation");
assert(
  engineeringAcceptance.includes("instead of repeatedly repairing the environment"),
  "Android DPAgent task must prevent environment repair loops"
);

const phaseOwnerProviders = new Set(
  (scenario.phase_tasks ?? [])
    .map((task) => Object.entries(roles).find(([, roleId]) => roleId === task.owner_role)?.[0])
    .filter(Boolean)
    .map((roleKey) => matrix[roleKey]?.provider_id)
    .filter(Boolean)
);
assertEqualArray([...phaseOwnerProviders], ["dpagent", "minimax"], "phase task owner providers");

const pkg = readJson(packagePath);
assert(
  pkg.scripts?.["e2e:workflow:mix-dpagent"] ===
    "node tools/run-powershell-entry.mjs ./E2ETest/scripts/run-workflow-mix-dpagent-e2e.ps1",
  "Missing or invalid package script e2e:workflow:mix-dpagent"
);
assert(
  pkg.scripts?.["e2e:baseline"] === "node tools/run-powershell-entry.mjs ./E2ETest/scripts/run-multi-e2e.ps1",
  "e2e:baseline must remain unchanged"
);

const runnerText = fs.readFileSync(runnerPath, "utf8");
assert(
  runnerText.includes("D:/MinimaxTest/config.yaml"),
  "Runner must default SourceConfigPath to D:/MinimaxTest/config.yaml"
);
assert(
  runnerText.includes("D:/work/MiniMaxAgentNodeJs"),
  "Runner must default DpAgentRoot to D:/work/MiniMaxAgentNodeJs"
);
assert(runnerText.includes("workflow-gesture-mix-dpagent.json"), "Runner must call the workflow mix DPAgent scenario");
assert(runnerText.includes("Resolve-DpAgentCliLaunch"), "Runner must resolve DPAgent dev-source or dist launch mode");
assert(
  runnerText.includes("Resolve-DpAgentBackendLaunch"),
  "Runner must resolve DPAgent backend dev-server or dist launch mode"
);
assert(runnerText.includes("src\\cli\\minimax-agent.ts"), "Runner must support DPAgent dev source launch");
assert(runnerText.includes("src\\web\\server\\index.ts"), "Runner must support DPAgent dev server launch");
assert(runnerText.includes("Invoke-DpAgentCredentialSmoke"), "Runner must fail fast on invalid DPAgent credentials");
assert(!/sk-cp-|sk-[A-Za-z0-9_-]{20,}/.test(runnerText), "Runner must not contain hardcoded provider keys");

const workflowRunnerText = fs.readFileSync(path.join(repoRoot, "E2ETest", "scripts", "run-workflow-e2e.ps1"), "utf8");
assert(
  workflowRunnerText.includes("provider_activity_coverage_pass"),
  "Workflow E2E must require every expected provider to have runtime activity"
);

const wrapperText = fs.readFileSync(path.join(repoRoot, "E2ETest", "scripts", "dpagent-dev-wrapper.cmd"), "utf8");
assert(
  !/minimax-agent\.js"\s+exec\s+%[*]/i.test(wrapperText),
  "DPAgent wrapper must not duplicate the exec argument supplied by EAT"
);
assert(wrapperText.includes("src\\cli\\minimax-agent.ts"), "DPAgent wrapper must support dev source launch");

console.log("[workflow-mix-dpagent-e2e] ok");
