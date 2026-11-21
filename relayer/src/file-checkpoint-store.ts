// SPDX-License-Identifier: MIT

/** Default file-backed {@link CheckpointStore}. */
import { readFile } from "node:fs/promises";
import type { Logger } from "@perihelion/node-common";
import type { CheckpointStore } from "./checkpoint.js";
import { nonceKey } from "./checkpoint.js";
import { quarantineCorruptFile, writeFileDurably } from "./durable-file.js";

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
 * `await`s could overwrite each other's update. Writes are fsync'd before the
 * rename (see {@link writeFileDurably}).
 *
 * If the file is not valid JSON it is moved aside and the store starts empty,
 * so the relayer falls back to its configured start block instead of crashing
 * on every restart. Note that a quarantined file also drops the persisted
 * nonce counters; operators should inspect the `.corrupt-*` file if the
 * settlement contract later reports `StaleNonce`.
 */
export class FileCheckpointStore implements CheckpointStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly log?: Logger,
  ) {}

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

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      await quarantineCorruptFile(this.path, (err as Error).message, this.log);
      return { nonces: {} };
    }
    if (parsed === null || typeof parsed !== "object") {
      await quarantineCorruptFile(this.path, "checkpoint is not a JSON object", this.log);
      return { nonces: {} };
    }

    const record = parsed as { cursor?: unknown; nonces?: unknown };
    const nonces: Record<string, number> = {};
    if (record.nonces && typeof record.nonces === "object") {
      for (const [key, value] of Object.entries(record.nonces)) {
        if (typeof value === "number") nonces[key] = value;
      }
    }
    return {
      cursor: typeof record.cursor === "number" ? record.cursor : undefined,
      nonces,
    };
  }

  private async writeState(state: CheckpointState): Promise<void> {
    await writeFileDurably(this.path, JSON.stringify(state));
  }
}
