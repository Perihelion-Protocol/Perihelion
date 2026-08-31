// SPDX-License-Identifier: MIT

/**
 * Tests for the mempool's `loadConfig` — every invalid value must be reported
 * at startup, by name, and all at once, matching the solver and relayer (#568).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

const VALID_ESCROW = "0x00000000000000000000000000000000000000aa";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PERIHELION_SOURCE_CHAIN_ID: "8453",
    PERIHELION_ESCROW_ADDRESS: VALID_ESCROW,
    ...overrides,
  };
}

test("loadConfig returns a validated config and applies defaults", () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.port, 3000);
  assert.equal(config.host, "localhost");
  assert.equal(config.chainId, 8453);
  assert.equal(config.verifyingContract, VALID_ESCROW);
  assert.equal(config.statusToken, undefined);
});

test("loadConfig rejects a non-numeric PORT, naming the variable (#568)", () => {
  assert.throws(() => loadConfig(baseEnv({ PORT: "not-a-port" })), /PORT must be an integer/);
});

test("loadConfig rejects an out-of-range PORT (#568)", () => {
  assert.throws(
    () => loadConfig(baseEnv({ PORT: "70000" })),
    /PORT must be an integer between 1 and 65535/,
  );
  assert.throws(() => loadConfig(baseEnv({ PORT: "0" })), /PORT must be an integer/);
});

test("loadConfig rejects a malformed escrow address, naming the variable (#568)", () => {
  assert.throws(
    () => loadConfig(baseEnv({ PERIHELION_ESCROW_ADDRESS: "0xdeadbeef" })),
    /PERIHELION_ESCROW_ADDRESS must be a 0x-prefixed 20-byte EVM address/,
  );
});

test("loadConfig reports missing required vars together (#568)", () => {
  let message = "";
  try {
    loadConfig({});
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.match(message, /PERIHELION_SOURCE_CHAIN_ID is required/);
  assert.match(message, /PERIHELION_ESCROW_ADDRESS is required/);
});

test("loadConfig reports every failure at once, not just the first (#568)", () => {
  let message = "";
  try {
    loadConfig({ PORT: "abc", PERIHELION_ESCROW_ADDRESS: "nope" });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.match(message, /PORT must be an integer/);
  assert.match(message, /PERIHELION_SOURCE_CHAIN_ID is required/);
  assert.match(message, /PERIHELION_ESCROW_ADDRESS must be a 0x-prefixed/);
});

test("loadConfig passes through a configured status token and host", () => {
  const config = loadConfig(
    baseEnv({ PERIHELION_MEMPOOL_STATUS_TOKEN: "shhh", PERIHELION_MEMPOOL_HOST: "0.0.0.0" }),
  );
  assert.equal(config.statusToken, "shhh");
  assert.equal(config.host, "0.0.0.0");
});
