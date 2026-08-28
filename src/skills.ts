import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface LoadedSkill {
  name: string;
  description: string;
  instructions: string;
  path: string;
}

export interface SkillLoader {
  load(names: readonly string[]): Promise<readonly LoadedSkill[]>;
}

export interface SkillDescriptor {
  name: string;
  description: string;
}

export interface SkillCatalog extends SkillLoader {
  list(): Promise<readonly SkillDescriptor[]>;
}

export class FileSystemSkillLoader implements SkillCatalog {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async load(names: readonly string[]): Promise<readonly LoadedSkill[]> {
    const root = await realpath(this.root);
    return Promise.all(names.map((name) => this.loadOne(name, root)));
  }

  async list(): Promise<readonly SkillDescriptor[]> {
    const root = await realpath(this.root);
    const entries = await readdir(root, { withFileTypes: true });
    const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const loaded = await Promise.all(names.map((name) => this.loadOne(name, root)));
    return loaded.map(({ name, description }) => ({ name, description }));
  }

  private async loadOne(name: string, root: string): Promise<LoadedSkill> {
    const path = resolve(this.root, name, "SKILL.md");
    const directory = resolve(this.root, name);
    assertWithinRoot(this.root, directory);

    const realDirectory = await realpath(directory);
    assertWithinRoot(root, realDirectory);

    const realSkillPath = await realpath(resolve(realDirectory, "SKILL.md"));
    assertWithinRoot(root, realSkillPath);

    const raw = await readFile(realSkillPath, "utf8");
    const { metadata, instructions } = parseSkill(raw);
    if (metadata.name !== undefined && metadata.name !== name) {
      throw new Error(`Skill metadata name must match its directory: ${name}`);
    }
    return {
      name,
      description: metadata.description ?? "",
      instructions,
      path,
    };
  }
}

function assertWithinRoot(root: string, target: string): void {
  const child = relative(root, target);
  if (child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))) {
    return;
  }
  throw new Error("Skill path escapes configured root");
}

function parseSkill(raw: string): {
  metadata: Record<string, string>;
  instructions: string;
} {
  if (!raw.startsWith("---\n")) return { metadata: {}, instructions: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("Invalid SKILL.md frontmatter");
  const metadata: Record<string, string> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
      metadata[key] = value;
    }
  }
  return { metadata, instructions: raw.slice(end + 5).trim() };
}
