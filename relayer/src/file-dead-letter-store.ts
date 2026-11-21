// SPDX-License-Identifier: MIT

/** Persistent file-backed dead-letter store. */
import { readFile } from "node:fs/promises";
import type { Logger } from "@perihelion/node-common";
import type { DeadLetterStore, DeadLetterEntry } from "./dead-letter.js";
import { quarantineCorruptFile, writeFileDurably } from "./durable-file.js";
import type { MessageKey, PendingMessage } from "./types.js";
import { messageKeyString } from "./types.js";

/**
 * Upper bound on retained dead-letter entries. Every change rewrites the whole
 * file, so the cap bounds the cost of each write. When it is exceeded the
 * oldest entries are evicted and logged as warnings.
 */
export const DEFAULT_MAX_DEAD_LETTER_ENTRIES = 10_000;

/**
 * Persists dead-lettered messages to JSON for durability across restarts.
 *
 * This is the serialization layer only — it is deliberately *not* a
 * {@link DeadLetterStore}. `HybridDeadLetterStore` below owns the in-memory
 * queue semantics (add/list/drain/discard/has) and delegates persistence here.
 */
export class FileDeadLetterStore {
  constructor(
    private readonly path: string,
    private readonly log?: Logger,
  ) {}

  async load(): Promise<Map<string, DeadLetterEntry>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new Map();
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      await quarantineCorruptFile(this.path, (err as Error).message, this.log);
      return new Map();
    }
    if (parsed === null) return new Map();
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      await quarantineCorruptFile(this.path, "dead-letter file is not a JSON object", this.log);
      return new Map();
    }
    return new Map(Object.entries(parsed as Record<string, DeadLetterEntry>));
  }

  async save(entries: Map<string, DeadLetterEntry>): Promise<void> {
    await writeFileDurably(this.path, JSON.stringify(Object.fromEntries(entries), null, 2));
  }
}

/** Options for {@link HybridDeadLetterStore}. */
export interface HybridDeadLetterStoreOptions {
  /** Maximum retained entries; oldest are evicted first. */
  maxEntries?: number;
  logger?: Logger;
}

/**
 * In-memory dead-letter store that optionally syncs to disk.
 * Wraps both in-memory state and a FileDeadLetterStore for persistence.
 */
export class HybridDeadLetterStore implements DeadLetterStore {
  private readonly entries = new Map<string, DeadLetterEntry>();
  private readonly fileStore: FileDeadLetterStore;
  private readonly maxEntries: number;
  private readonly log?: Logger;

  constructor(filePath: string, opts: HybridDeadLetterStoreOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_DEAD_LETTER_ENTRIES;
    this.log = opts.logger;
    this.fileStore = new FileDeadLetterStore(filePath, opts.logger);
  }

  async load(): Promise<void> {
    const persisted = await this.fileStore.load();
    this.entries.clear();
    for (const [key, entry] of persisted.entries()) {
      this.entries.set(key, entry);
    }
    this.evictOverflow();
  }

  add(
    key: MessageKey,
    pending: PendingMessage,
    attempts: number,
    lastError: string,
  ): void {
    this.entries.set(messageKeyString(key), {
      key,
      pending,
      attempts,
      lastError,
      deadLetteredAt: Date.now(),
    });
    this.evictOverflow();
  }

  list(): DeadLetterEntry[] {
    return [...this.entries.values()];
  }

  drain(): DeadLetterEntry[] {
    const all = this.list();
    this.entries.clear();
    return all;
  }

  discard(key: MessageKey): boolean {
    return this.entries.delete(messageKeyString(key));
  }

  has(key: MessageKey): boolean {
    return this.entries.has(messageKeyString(key));
  }

  async persist(): Promise<void> {
    await this.fileStore.save(this.entries);
  }

  /**
   * Drop the oldest entries until the cap holds. Map iteration follows
   * insertion order, so the first key is the oldest dead letter.
   */
  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      this.log?.warn("dead-letter store full; evicted oldest entry", {
        evictedKey: oldest,
        maxEntries: this.maxEntries,
      });
    }
  }
}
