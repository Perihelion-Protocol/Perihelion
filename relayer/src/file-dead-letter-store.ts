// SPDX-License-Identifier: MIT

/** Persistent file-backed dead-letter store. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DeadLetterStore, DeadLetterEntry } from "./dead-letter.js";
import type { MessageKey, PendingMessage } from "./types.js";
import { messageKeyString } from "./types.js";

/**
 * Persists dead-lettered messages to JSON for durability across restarts.
 *
 * This is the serialization layer only — it is deliberately *not* a
 * {@link DeadLetterStore}. `HybridDeadLetterStore` below owns the in-memory
 * queue semantics (add/list/drain/discard/has) and delegates persistence here.
 */
export class FileDeadLetterStore {
  constructor(private readonly path: string) {}

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
    const parsed = JSON.parse(raw) as Record<string, DeadLetterEntry> | undefined;
    if (!parsed) return new Map();
    return new Map(Object.entries(parsed));
  }

  async save(entries: Map<string, DeadLetterEntry>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const obj = Object.fromEntries(entries);
    const tmpPath = `${this.path}.tmp`;
    await writeFile(tmpPath, JSON.stringify(obj, null, 2), "utf8");
    await rename(tmpPath, this.path);
  }
}

/**
 * In-memory dead-letter store that optionally syncs to disk.
 * Wraps both in-memory state and a FileDeadLetterStore for persistence.
 */
export class HybridDeadLetterStore implements DeadLetterStore {
  private readonly entries = new Map<string, DeadLetterEntry>();
  private readonly fileStore: FileDeadLetterStore;

  constructor(filePath: string) {
    this.fileStore = new FileDeadLetterStore(filePath);
  }

  async load(): Promise<void> {
    const persisted = await this.fileStore.load();
    this.entries.clear();
    for (const [key, entry] of persisted.entries()) {
      this.entries.set(key, entry);
    }
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
}
