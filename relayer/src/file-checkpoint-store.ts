/** Default file-backed {@link CheckpointStore}. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CheckpointStore } from "./checkpoint.js";

/** Persists the cursor as JSON to a local file. */
export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly path: string) {}

  async load(): Promise<number | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const parsed = JSON.parse(raw) as { cursor?: unknown };
    return typeof parsed.cursor === "number" ? parsed.cursor : undefined;
  }

  async save(block: number): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Write to a temp file and rename so a crash mid-write can't corrupt the checkpoint.
    const tmpPath = `${this.path}.tmp`;
    await writeFile(tmpPath, JSON.stringify({ cursor: block }), "utf8");
    await rename(tmpPath, this.path);
  }
}
