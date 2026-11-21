// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileCheckpointStore } from "../src/file-checkpoint-store.js";
import { checkpointNonceCounter } from "../src/checkpoint.js";

test("FileCheckpointStore returns undefined when no checkpoint file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perihelion-checkpoint-"));
  try {
    const store = new FileCheckpointStore(join(dir, "cursor.json"));
    assert.equal(await store.load(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FileCheckpointStore persists and reloads the cursor across instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perihelion-checkpoint-"));
  try {
    const path = join(dir, "nested", "cursor.json");
    const writer = new FileCheckpointStore(path);
    await writer.save(12345);

    const reader = new FileCheckpointStore(path);
    assert.equal(await reader.load(), 12345);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FileCheckpointStore overwrites a previous checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perihelion-checkpoint-"));
  try {
    const store = new FileCheckpointStore(join(dir, "cursor.json"));
    await store.save(1);
    await store.save(2);
    assert.equal(await store.load(), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FileCheckpointStore persists per-path nonces across instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perihelion-checkpoint-"));
  try {
    const path = join(dir, "cursor.json");
    await new FileCheckpointStore(path).saveNonce(1, 2, 7);

    const reader = new FileCheckpointStore(path);
    assert.equal(await reader.loadNonce(1, 2), 7);
    assert.equal(await reader.loadNonce(1, 3), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saving the cursor keeps persisted nonces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perihelion-checkpoint-"));
  try {
    const path = join(dir, "cursor.json");
    const store = new FileCheckpointStore(path);
    await store.saveNonce(1, 2, 5);
    await store.save(100);

    const reader = new FileCheckpointStore(path);
    assert.equal(await reader.load(), 100);
    assert.equal(await reader.loadNonce(1, 2), 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkpointNonceCounter keeps nonces strictly increasing across a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perihelion-checkpoint-"));
  try {
    const path = join(dir, "cursor.json");

    const before = checkpointNonceCounter(new FileCheckpointStore(path), 1, 2);
    const first = await before.next("1:2");
    const second = await before.next("1:2");

    // Simulated restart: a new store and counter over the same file.
    const after = checkpointNonceCounter(new FileCheckpointStore(path), 1, 2);
    const third = await after.next("1:2");

    assert.equal(first, 1n);
    assert.equal(second, 2n);
    assert.equal(third, 3n);
    assert.ok(third > second && second > first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
