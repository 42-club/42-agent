import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileSystemSkillLoader } from "../src/skills.js";

test("FileSystemSkillLoader loads skills contained by its configured root", async () => {
  await withSkillDirectories(async ({ root }) => {
    const directory = join(root, "review");
    await mkdir(directory);
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: review\ndescription: Review code changes\n---\nInspect the implementation.",
    );

    const loader = new FileSystemSkillLoader(root);
    assert.deepEqual(await loader.list(), [
      { name: "review", description: "Review code changes" },
    ]);
    assert.deepEqual(await loader.load(["review"]), [
      {
        name: "review",
        description: "Review code changes",
        instructions: "Inspect the implementation.",
        path: join(root, "review", "SKILL.md"),
      },
    ]);
  });
});

test("FileSystemSkillLoader exposes names that can be loaded", async () => {
  await withSkillDirectories(async ({ root }) => {
    const directory = join(root, "review");
    await mkdir(directory);
    await writeFile(join(directory, "SKILL.md"), [
      "---",
      "name: review",
      "description: Review code changes",
      "---",
      "Inspect the implementation.",
    ].join("\n"));

    const loader = new FileSystemSkillLoader(root);
    const [descriptor] = await loader.list();
    assert.equal((await loader.load([descriptor!.name]))[0]?.name, descriptor?.name);
  });
});

test("FileSystemSkillLoader rejects metadata names that disagree with the directory", async () => {
  await withSkillDirectories(async ({ root }) => {
    const directory = join(root, "review");
    await mkdir(directory);
    await writeFile(join(directory, "SKILL.md"), [
      "---",
      "name: reviewer",
      "---",
      "Inspect the implementation.",
    ].join("\n"));

    const loader = new FileSystemSkillLoader(root);
    await assert.rejects(loader.list(), /metadata name must match its directory/);
  });
});

test("FileSystemSkillLoader rejects a skill directory symlink outside its root", async () => {
  await withSkillDirectories(async ({ root, outside }) => {
    const externalSkill = join(outside, "external-skill");
    await mkdir(externalSkill);
    await writeFile(join(externalSkill, "SKILL.md"), "external instructions");
    await symlink(externalSkill, join(root, "escaped"), "dir");

    const loader = new FileSystemSkillLoader(root);
    await assert.rejects(loader.load(["escaped"]), /Skill path escapes configured root/);
  });
});

test("FileSystemSkillLoader rejects a SKILL.md symlink outside its root", async () => {
  await withSkillDirectories(async ({ root, outside }) => {
    const directory = join(root, "escaped-file");
    const externalSkill = join(outside, "external-SKILL.md");
    await mkdir(directory);
    await writeFile(externalSkill, "external instructions");
    await symlink(externalSkill, join(directory, "SKILL.md"), "file");

    const loader = new FileSystemSkillLoader(root);
    await assert.rejects(loader.load(["escaped-file"]), /Skill path escapes configured root/);
  });
});

async function withSkillDirectories(
  run: (paths: { root: string; outside: string }) => Promise<void>,
): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "42-agent-skills-"));
  const root = join(parent, "root");
  const outside = join(parent, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  try {
    await run({ root, outside });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
