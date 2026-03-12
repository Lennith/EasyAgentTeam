import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const schemaDir = path.join(root, "agent_library", "src", "schemas");
const requiredFiles = [
  "task-action.schema.json",
  "provider-runtime.schema.json",
  "manager-to-agent-message.schema.json",
  "lock-record.schema.json",
  "event-record.schema.json"
];

async function main() {
  for (const filename of requiredFiles) {
    const fullPath = path.join(schemaDir, filename);
    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw);

    if (parsed.type !== "object") {
      throw new Error(`${filename} must declare object type`);
    }

    if (!Array.isArray(parsed.required) || parsed.required.length === 0) {
      throw new Error(`${filename} must have required fields`);
    }
  }

  console.log("[check_schemas] all schema files parsed and validated.");
}

main().catch((error) => {
  console.error("[check_schemas] failed:", error.message);
  process.exitCode = 1;
});
