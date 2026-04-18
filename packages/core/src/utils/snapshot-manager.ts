import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface SnapshotData {
  chapter: number;
  values: Record<string, string>;
}

export class SnapshotManager {
  private runtimeDir: string;

  constructor(runtimeDir: string) {
    this.runtimeDir = runtimeDir;
  }

  private getSnapshotPath(chapter: number): string {
    return join(this.runtimeDir, `snapshot-${chapter}.md`);
  }

  async save(numericalFacts: Record<string, string>, chapter: number): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true });

    const snapshotPath = this.getSnapshotPath(chapter);
    const entries = Object.entries(numericalFacts).filter(([, v]) => v !== "不变");

    if (entries.length === 0) {
      await writeFile(snapshotPath, "", "utf-8");
      return;
    }

    const lines: string[] = [];
    for (const [key, value] of entries) {
      lines.push(`${key}: ${value}`);
    }

    await writeFile(snapshotPath, lines.join("\n"), "utf-8");
  }

  async load(chapter: number): Promise<SnapshotData | null> {
    try {
      const snapshotPath = this.getSnapshotPath(chapter);
      const content = await readFile(snapshotPath, "utf-8");

      if (!content.trim()) {
        return null;
      }

      const lines = content.split("\n").filter(Boolean);
      const values: Record<string, string> = {};

      for (const line of lines) {
        if (line.includes(":")) {
          const [key, ...valueParts] = line.split(":");
          if (key && valueParts.length > 0) {
            values[key.trim()] = valueParts.join(":").trim();
          }
        }
      }

      if (Object.keys(values).length === 0) {
        return null;
      }

      return {
        chapter,
        values,
      };
    } catch {
      return null;
    }
  }

  async deleteFrom(chapter: number): Promise<void> {
    try {
      const files = await readdir(this.runtimeDir);
      for (const file of files) {
        if (file.startsWith("snapshot-")) {
          const fileChapter = parseInt(file.replace("snapshot-", "").replace(".md", ""), 10);
          if (fileChapter >= chapter) {
            await unlink(join(this.runtimeDir, file));
          }
        }
      }
    } catch {
      // directory empty or not exists, ignore
    }
  }

  async formatForPrompt(): Promise<string> {
    const files = await readdir(this.runtimeDir);
    const snapshotFiles = files.filter((f) => f.startsWith("snapshot-")).sort();

    if (snapshotFiles.length === 0) {
      return "";
    }

    const latestFile = snapshotFiles[snapshotFiles.length - 1];
    const chapter = parseInt(latestFile.replace("snapshot-", "").replace(".md", ""), 10);
    const snapshot = await this.load(chapter);

    if (!snapshot || !snapshot.values || Object.keys(snapshot.values).length === 0) {
      return "";
    }

    const lines: string[] = [];
    for (const [key, value] of Object.entries(snapshot.values)) {
      lines.push(`${key}: ${value}`);
    }

    return lines.join("\n");
  }
}