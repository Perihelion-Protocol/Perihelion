// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quarantineCorruptFile, writeFileDurably, type DurableFs, type FileSink } from "../src/durable-file.js";
import { FileCheckpointStore } from "../src/file-checkpoint-store.js";
import { HybridDeadLetterStore } from "../src/file-dead-letter-store.js";

/** Fake filesystem that records every durability-relevant call in order. */
function recordingFs(): { fs: DurableFs; calls: string[] } {
  const calls: string[] = [];
  const fs: DurableFs = {
    async mkdir(dir) {
      calls.push(`mkdir:${dir}`);
    },
    async openFile(path, flags): Promise<FileSink> {
      calls.push(`open:${flags}:${path}`);
      return {
        async write(data) {
          calls.push(`write:${path}:${data.length}`);
        },
        async sync() {
          calls.push(`fsync:${path}`);
        },
        async close() {
          calls.push(`close:${path}`);
        },
      };
    },
    async rename(from, to) {
      calls.push(`rename:${from}->${to}`);
    },
  };
  return { fs, calls };
}

test("writeFileDurably fsyncs the temp file before rename and the directory after", async () => {
  const { fs, calls } = recordingFs();
  await writeFileDurably("/state/cursor.json", "{}", fs);

  assert.deepEqual(calls, [
    "mkdir:/state",
    "open:w:/state/cursor.json.tmp",
    "write:/state/cursor.json.tmp:2",
    "fsync:/state/cursor.json.tmp",
    "close:/state/cursor.json.tmp",
    "rename:/state/cursor.json.tmp->/state/cursor.json",
    "open:r:/state",
    "fsync:/state",
    "close:/state",
  ]);
});

test("writeFileDurably closes the temp file even when the write fails", async () => {
  const calls: string[] = [];
  const fs: DurableFs = {
    async mkdir() {},
    async openFile(path): Promise<FileSink> {
      return {
        async write() {
          throw new Error("disk full");
        },
        async sync() {
          calls.push("fsync");
        },
        async close() {
          calls.push(`close:${path}`);
        },
      };
    },
    async rename() {
      calls.push("rename");
    },
  };

  await assert.rejects(writeFileDurably("/state/x.json", "{}", fs), /disk full/);
  assert.deepEqual(calls, ["close:/state/x.json.tmp"]);
});

test("a corrupt checkpoint is quarantined and the store starts empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perihelion-quarantine-"));
  try {
    const path = join(dir, "checkpoint.json");
    await writeFile(path, '{"cursor": 12');

    const store = new FileCheckpointStore(path);
    assert.equal(await store.load(), undefined);

    const remaining = await readdir(dir);
    const quarantined = remaining.filter((name) => name.startsWith("checkpoint.json.corrupt-"));
    assert.equal(quarantined.length, 1);
    assert.equal(await readFile(join(dir, quarantined[0]!), "utf8"), '{"cursor": 12');
    assert.equal(remaining.includes("checkpoint.json"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("quarantineCorruptFile moves the file aside and logs the reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perihelion-quarantine-"));
  try {
    const path = join(dir, "dead.json");
    await writeFile(path, "not json");
    const logged: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const log = {
      info() {},
      warn() {},
      error(msg: string, meta?: Record<string, unknown>) {
        logged.push({ msg, meta });
      },
    };

    const dest = await quarantineCorruptFile(path, "bad token", log);
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.meta?.reason, "bad token");
    assert.equal(await readFile(dest, "utf8"), "not json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HybridDeadLetterStore evicts the oldest entries beyond maxEntries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perihelion-dl-"));
  try {
    const store = new HybridDeadLetterStore(join(dir, "dl.json"), { maxEntries: 2 });
    const keyFor = (nonce: number) => ({
      srcEid: 30101,
      dstEid: 40161,
      intentHash: "0x01" as const,
      messageType: 1 as never,
      nonce,
    });
    const pending = {} as never;

    store.add(keyFor(1), pending, 1, "err");
    store.add(keyFor(2), pending, 1, "err");
    store.add(keyFor(3), pending, 1, "err");

    assert.equal(store.list().length, 2);
    assert.equal(store.has(keyFor(1)), false);
    assert.equal(store.has(keyFor(2)), true);
    assert.equal(store.has(keyFor(3)), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
