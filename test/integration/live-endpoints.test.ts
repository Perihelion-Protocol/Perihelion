// SPDX-License-Identifier: MIT

/**
 * Live-endpoint integration checks.
 *
 * These tests talk to real EVM and Soroban JSON-RPC servers. They are skipped
 * unless `PERIHELION_INTEGRATION=1` is set, so the default `npm test` run stays
 * hermetic.
 *
 * Scope: this file verifies that the configured endpoints are reachable and
 * speak the expected protocol. It does NOT yet deploy the contracts or drive a
 * full intent lifecycle through the relayer and solver; that remains open under
 * issue #976 ("real contracts and real service binaries complete an intent").
 *
 * Required environment when enabled:
 *   PERIHELION_INTEGRATION=1
 *   PERIHELION_EVM_RPC_URL       e.g. an Anvil instance (http://127.0.0.1:8545)
 *   PERIHELION_SOROBAN_RPC_URL   e.g. a Stellar quickstart Soroban RPC
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const enabled = process.env.PERIHELION_INTEGRATION === "1";
const skip = enabled
  ? false
  : "set PERIHELION_INTEGRATION=1 (plus the RPC URLs) to run live endpoint checks";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set when PERIHELION_INTEGRATION=1`);
  }
  return value;
}

async function jsonRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(res.status, 200, `${method} returned HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  assert.equal(body.error, undefined, `${method} returned error: ${body.error?.message}`);
  return body.result;
}

test("integration: EVM RPC answers eth_chainId", { skip }, async () => {
  const chainId = await jsonRpc(requiredEnv("PERIHELION_EVM_RPC_URL"), "eth_chainId", []);
  assert.equal(typeof chainId, "string");
  assert.match(chainId as string, /^0x[0-9a-fA-F]+$/);
});

test("integration: Soroban RPC reports healthy", { skip }, async () => {
  const health = (await jsonRpc(requiredEnv("PERIHELION_SOROBAN_RPC_URL"), "getHealth", [])) as {
    status?: string;
  };
  assert.equal(health.status, "healthy");
});
