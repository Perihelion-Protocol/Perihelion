// SPDX-License-Identifier: MIT

/** Default file-backed {@link CheckpointStore}. */
import { readFile } from "node:fs/promises";
import type { Logger } from "@perihelion/node-common";
import type { CheckpointStore } from "./checkpoint.js";
import { nonceKey } from "./checkpoint.js";
import { quarantineCorruptFile, writeFileDurably } from "./durable-file.js";

/** On-disk shape: the scan cursor plus the last nonce emitted per path. */
interface CheckpointState {
  cursor?: number;
  /** Keyed by `${srcEid}:${dstEid}`. */
  nonces: Record<string, number>;
}

function pathKey(srcEid: number, dstEid: number): string {
  return `${srcEid}:${dstEid}`;
}

/**
 * Persists the cursor and per-path nonces as JSON in a local file. Every write
 * keeps the other fields, and writes are serialised within the process so a
 * cursor save cannot drop a nonce that was saved concurrently.
 */
export class FileCheckpointStore implements CheckpointStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<number | undefined> {
    return (await this.readState()).cursor;
  }

  async save(block: number): Promise<void> {
    await this.update((state) => {
      state.cursor = block;
    });
  }

  async loadNonce(srcEid: number, dstEid: number): Promise<number | undefined> {
    return (await this.readState()).nonces[pathKey(srcEid, dstEid)];
  }

  async saveNonce(srcEid: number, dstEid: number, nonce: number): Promise<void> {
    await this.update((state) => {
      state.nonces[pathKey(srcEid, dstEid)] = nonce;
    });
  }

  private update(mutate: (state: CheckpointState) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const state = await this.readState();
      mutate(state);
      await this.writeState(state);
    });
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
