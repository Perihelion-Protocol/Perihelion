// SPDX-License-Identifier: MIT

/** Default file-backed {@link CheckpointStore}. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CheckpointStore } from "./checkpoint.js";
import { nonceKey } from "./checkpoint.js";

/** On-disk shape: `{ cursor, nonces: { "<srcEid>:<dstEid>": n } }`. */
interface CheckpointState {
  cursor?: number;
  nonces: Record<string, number>;
}

/**
 * Persists the cursor and per-path LayerZero nonces as JSON to a local file.
 *
 * Both values share one file, so every read-modify-write is serialized through
 * a promise chain; otherwise a cursor save and a nonce save interleaving across
 * `await`s could overwrite each other's update.
 */
export class FileCheckpointStore implements CheckpointStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<number | undefined> {
    return (await this.readState()).cursor;
  }

  async save(block: number): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.readState();
      await this.writeState({ ...state, cursor: block });
    });
  }

  async loadNonce(srcEid: number, dstEid: number): Promise<number | undefined> {
    return (await this.readState()).nonces[nonceKey(srcEid, dstEid)];
  }

  async saveNonce(srcEid: number, dstEid: number, nonce: number): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.readState();
      await this.writeState({
        ...state,
        nonces: { ...state.nonces, [nonceKey(srcEid, dstEid)]: nonce },
      });
    });
  }

  /** Run `fn` after all previously queued operations have settled. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readState(): Promise<CheckpointState> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { nonces: {} };
      throw err;
    }
    const parsed = JSON.parse(raw) as { cursor?: unknown; nonces?: unknown };
    const nonces: Record<string, number> = {};
    if (parsed.nonces && typeof parsed.nonces === "object") {
      for (const [key, value] of Object.entries(parsed.nonces)) {
        if (typeof value === "number") nonces[key] = value;
      }
    }
    return {
      cursor: typeof parsed.cursor === "number" ? parsed.cursor : undefined,
      nonces,
    };
  }

  private async writeState(state: CheckpointState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Write to a temp file and rename so a crash mid-write can't corrupt the checkpoint.
    const tmpPath = `${this.path}.tmp`;
    await writeFile(tmpPath, JSON.stringify(state), "utf8");
    await rename(tmpPath, this.path);
  }
}
