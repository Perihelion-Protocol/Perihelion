// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkpointNonceCounter } from "../src/checkpoint.js";
import { FileCheckpointStore } from "../src/file-checkpoint-store.js";

test("persisted nonce counter continues strictly increasing across a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perihelion-nonce-"));
  try {
    const path = join(dir, "checkpoint.json");

    const before = checkpointNonceCounter(new FileCheckpointStore(path), 30101, 40161);
    const first = await before.next("30101:40161");
    const second = await before.next("30101:40161");
    assert.equal(first, 1n);
    assert.equal(second, 2n);

    // Simulated restart: a fresh store and counter over the same file.
    const after = checkpointNonceCounter(new FileCheckpointStore(path), 30101, 40161);
    const third = await after.next("30101:40161");
    assert.equal(third, 3n);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nonce and cursor writes do not overwrite each other", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perihelion-nonce-"));
  try {
    const path = join(dir, "checkpoint.json");
    const store = new FileCheckpointStore(path);

    await Promise.all([store.save(500), store.saveNonce(30101, 40161, 7)]);

    const reader = new FileCheckpointStore(path);
    assert.equal(await reader.load(), 500);
    assert.equal(await reader.loadNonce(30101, 40161), 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
