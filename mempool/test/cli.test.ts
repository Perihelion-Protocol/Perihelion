// SPDX-License-Identifier: MIT

/**
 * Tests for the mempool CLI's process lifecycle: SIGTERM drains the server
 * cleanly, and a misconfigured environment aborts startup with a named
 * variable rather than binding a random port (#568).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(env: NodeJS.ProcessEnv) {
  return spawn(process.execPath, ["--import", "tsx", CLI], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("SIGTERM shuts the CLI server down cleanly (#568)", async () => {
  const child = runCli({
    PORT: "3994",
    PERIHELION_MEMPOOL_HOST: "127.0.0.1",
    PERIHELION_SOURCE_CHAIN_ID: "8453",
    PERIHELION_ESCROW_ADDRESS: "0x00000000000000000000000000000000000000aa",
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not start in time")), 15_000);
      child.stdout.on("data", (buf: Buffer) => {
        if (buf.toString().includes("listening on")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`CLI exited before it was ready (code ${code})`));
      });
    });

    child.kill("SIGTERM");
    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];

    assert.equal(signal, null, "process handled the signal and exited on its own");
    assert.equal(code, 0, "clean exit code after SIGTERM");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("the CLI aborts on an invalid PORT, naming the variable (#568)", async () => {
  const child = runCli({
    PORT: "banana",
    PERIHELION_SOURCE_CHAIN_ID: "8453",
    PERIHELION_ESCROW_ADDRESS: "0x00000000000000000000000000000000000000aa",
  });

  let stderr = "";
  child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
  const [code] = (await once(child, "exit")) as [number | null];

  assert.notEqual(code, 0, "non-zero exit when configuration is invalid");
  assert.match(stderr, /PORT must be an integer/);
});
