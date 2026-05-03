import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

if (!process.argv[2] || !process.argv[3]) {
  fail("Usage: node sync-dpagent-dev-config.mjs <source-config-path> <dpagent-root>");
}

const sourceConfigPath = path.resolve(process.argv[2]);
const dpAgentRoot = path.resolve(process.argv[3]);
const includeSecrets = process.argv.includes("--include-secrets");

if (!sourceConfigPath || !fs.existsSync(sourceConfigPath)) {
  fail(`Source config not found: ${sourceConfigPath}`);
}
if (!dpAgentRoot || !fs.existsSync(dpAgentRoot)) {
  fail(`DPAgent root not found: ${dpAgentRoot}`);
}

const requireFromDpAgent = createRequire(path.join(dpAgentRoot, "package.json"));
let yaml;
try {
  yaml = requireFromDpAgent("js-yaml");
} catch {
  fail(`Cannot load js-yaml from DPAgent node_modules under ${dpAgentRoot}. Run npm install in the DPAgent repo first.`);
}

const source = yaml.load(fs.readFileSync(sourceConfigPath, "utf8"));
const profiles = Array.isArray(source?.llmProfiles?.profiles) ? source.llmProfiles.profiles : [];
const kimiProfile = profiles.find((profile) => {
  const name = normalizeText(profile?.name).toLowerCase();
  const id = normalizeText(profile?.id).toLowerCase();
  return name === "kimi" || id === "kimi" || name.includes("kimi");
});
const minimaxProfile = profiles.find((profile) => {
  const name = normalizeText(profile?.name).toLowerCase();
  const id = normalizeText(profile?.id).toLowerCase();
  const model = normalizeText(profile?.defaultModel).toLowerCase();
  return name.includes("minimax") || id.includes("minimax") || model.startsWith("minimax-");
});

if (!kimiProfile) {
  fail("Source config does not contain a Kimi llm profile.");
}
if (!minimaxProfile) {
  fail("Source config does not contain a MiniMax llm profile.");
}
if (!normalizeText(kimiProfile.apiKey)) {
  fail("Kimi llm profile is missing apiKey.");
}
if (!normalizeText(minimaxProfile.apiKey)) {
  fail("MiniMax llm profile is missing apiKey.");
}

const nextConfig = cloneJson(source);
nextConfig.llmProfiles = {
  ...(nextConfig.llmProfiles ?? {}),
  defaultProfileId: kimiProfile.id,
  profiles: cloneJson(profiles)
};
nextConfig.agent = {
  ...(nextConfig.agent ?? {}),
  workspaceDir: "./workspace",
  contextDir: "./contexts",
  runtimeDataDir: "./runtime",
  globalAgentsDir: path.join(dpAgentRoot, "agents"),
  skillListPath: "./skill-list.yaml"
};

const targetConfigPath = path.join(dpAgentRoot, "config.yaml");
fs.writeFileSync(targetConfigPath, yaml.dump(nextConfig, { indent: 2, lineWidth: -1 }), "utf8");

console.log(
  JSON.stringify({
    dpAgentConfigPath: targetConfigPath,
    profileCount: profiles.length,
    kimi: {
      id: kimiProfile.id,
      name: kimiProfile.name,
      apiBase: kimiProfile.apiBase,
      defaultModel: kimiProfile.defaultModel,
      hasKey: Boolean(normalizeText(kimiProfile.apiKey))
    },
    minimax: {
      id: minimaxProfile.id,
      name: minimaxProfile.name,
      apiKey: includeSecrets ? minimaxProfile.apiKey : undefined,
      apiBase: minimaxProfile.apiBase,
      defaultModel: minimaxProfile.defaultModel,
      hasKey: Boolean(normalizeText(minimaxProfile.apiKey))
    }
  })
);
