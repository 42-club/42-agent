import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export interface LoadedSkill {
  name: string;
  description: string;
  instructions: string;
  path: string;
}

export interface SkillLoader {
  load(names: readonly string[]): Promise<readonly LoadedSkill[]>;
}

export class FileSystemSkillLoader implements SkillLoader {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async load(names: readonly string[]): Promise<readonly LoadedSkill[]> {
    return Promise.all(names.map((name) => this.loadOne(name)));
  }

  private async loadOne(name: string): Promise<LoadedSkill> {
    const path = resolve(this.root, name, "SKILL.md");
    if (!path.startsWith(`${this.root}${sep}`)) throw new Error("Skill path escapes configured root");
    const raw = await readFile(path, "utf8");
    const { metadata, instructions } = parseSkill(raw);
    return {
      name: metadata.name ?? name,
      description: metadata.description ?? "",
      instructions,
      path,
    };
  }
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
