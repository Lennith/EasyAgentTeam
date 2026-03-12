import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import {
  createSkillList,
  importSkills,
  listSkills,
  resolveImportedSkillPromptSegments,
  resolveSkillIdsForAgent,
  validateSkillListIds
} from "../data/skill-store.js";

async function writeSkillPackage(
  root: string,
  relativeDir: string,
  content: string,
  extraFile?: string
): Promise<string> {
  const skillDir = path.join(root, relativeDir);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
  if (extraFile) {
    const extraPath = path.join(skillDir, extraFile);
    await fs.mkdir(path.dirname(extraPath), { recursive: true });
    await fs.writeFile(extraPath, "dependency", "utf8");
  }
  return skillDir;
}

test("importSkills recursively imports skill folders and copies dependencies", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-skill-store-import-"));
  const dataRoot = path.join(tempRoot, "data");
  const sourceRoot = path.join(tempRoot, ".config", "opencode", "skills");
  const skillDir = await writeSkillPackage(
    sourceRoot,
    "minimax-vision",
    "# MiniMax Vision\n\nAnalyze screenshots and images.",
    "assets/model/config.json"
  );

  const result = await importSkills(dataRoot, { sources: [sourceRoot], recursive: true });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0]?.skill.skillId, "minimax-vision");
  assert.equal(result.imported[0]?.skill.compatibility, "opencode");
  assert.equal(result.warnings.length > 0, true);

  const skills = await listSkills(dataRoot);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.sourcePath, skillDir);
  const resolvedSegments = await resolveImportedSkillPromptSegments(dataRoot, [skills[0]?.skillId ?? ""]);
  assert.equal(resolvedSegments.resolvedSkillIds.length, 1);
  assert.equal(resolvedSegments.segments.length, 1);
  assert.equal(resolvedSegments.segments[0]?.includes("Imported Skill"), true);

  const normalizedSkillMd = await fs.readFile(
    path.join(dataRoot, "skills", "packages", "minimax-vision", "SKILL.md"),
    "utf8"
  );
  assert.equal(normalizedSkillMd.includes("name: minimax-vision"), true);
  assert.equal(normalizedSkillMd.includes("description:"), true);
  assert.equal(normalizedSkillMd.includes("license: UNSPECIFIED"), true);
  assert.equal(normalizedSkillMd.includes("compatibility: opencode"), true);
  assert.equal(
    await fs
      .access(path.join(dataRoot, "skills", "packages", "minimax-vision", "assets", "model", "config.json"))
      .then(() => true)
      .catch(() => false),
    true
  );
});

test("importSkills supports single SKILL.md source and overwrite update", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-skill-store-overwrite-"));
  const dataRoot = path.join(tempRoot, "data");
  const codexSkillDir = path.join(tempRoot, ".codex", "skills", "reviewer");
  await writeSkillPackage(
    path.join(tempRoot, ".codex", "skills"),
    "reviewer",
    "---\nname: reviewer\ndescription: first\nlicense: MIT\n---\n# Reviewer\n",
    undefined
  );
  const skillFile = path.join(codexSkillDir, "SKILL.md");

  const first = await importSkills(dataRoot, { sources: [skillFile] });
  assert.equal(first.imported[0]?.action, "created");
  assert.equal(first.imported[0]?.skill.compatibility, "codex");

  await fs.writeFile(
    skillFile,
    "---\nname: reviewer\ndescription: updated desc\nlicense: MIT\ncompatibility: codex\n---\n# Reviewer v2\n",
    "utf8"
  );
  const second = await importSkills(dataRoot, { sources: [skillFile] });
  assert.equal(second.imported[0]?.action, "updated");
  const skills = await listSkills(dataRoot);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.description, "updated desc");
});

test("skill list resolution respects include_all dynamic behavior and dedupe order", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-skill-store-lists-"));
  const dataRoot = path.join(tempRoot, "data");
  const sourceRoot = path.join(tempRoot, "skills-src");
  await writeSkillPackage(sourceRoot, "alpha", "---\nname: alpha\ndescription: a\nlicense: MIT\n---\nBody");
  await writeSkillPackage(sourceRoot, "beta", "---\nname: beta\ndescription: b\nlicense: MIT\n---\nBody");
  await importSkills(dataRoot, { sources: [sourceRoot], recursive: true });

  await createSkillList(dataRoot, {
    listId: "all-first",
    displayName: "All First",
    includeAll: true,
    skillIds: ["alpha"]
  });
  await createSkillList(dataRoot, {
    listId: "explicit-second",
    displayName: "Explicit Second",
    includeAll: false,
    skillIds: ["beta", "alpha"]
  });

  const resolvedA = await resolveSkillIdsForAgent(dataRoot, ["all-first", "explicit-second"]);
  assert.deepEqual(resolvedA, ["alpha", "beta"]);

  const resolvedB = await resolveSkillIdsForAgent(dataRoot, ["explicit-second", "all-first"]);
  assert.deepEqual(resolvedB, ["beta", "alpha"]);

  const invalidRefs = await validateSkillListIds(dataRoot, ["all-first", "missing-list"]);
  assert.deepEqual(invalidRefs, ["missing-list"]);
});
