import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileCheckpointStore } from "../src/file-checkpoint-store.js";

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
