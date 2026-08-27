// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { loadExecutorConfig } from "../src/executor-config.js";

const VALID_SOLVER = "0x1111111111111111111111111111111111111111";
const VALID_ESCROW = "0x2222222222222222222222222222222222222222";

function baseSolverEnv() {
  return {
    PERIHELION_SOLVER_ADDRESS: VALID_SOLVER,
    PERIHELION_ESCROW_ADDRESS: VALID_ESCROW,
  };
}

test("loadConfig throws a single consolidated error when required vars are missing", () => {
  assert.throws(
    () => loadConfig({}),
    /PERIHELION_SOLVER_ADDRESS is required[\s\S]*PERIHELION_ESCROW_ADDRESS is required/,
  );
});

test("loadConfig rejects an empty-string address instead of defaulting to the zero address", () => {
  assert.throws(
    () => loadConfig({ ...baseSolverEnv(), PERIHELION_SOLVER_ADDRESS: "" }),
    /PERIHELION_SOLVER_ADDRESS is required/,
  );
});

test("loadConfig rejects a malformed address", () => {
  assert.throws(
    () => loadConfig({ ...baseSolverEnv(), PERIHELION_ESCROW_ADDRESS: "not-an-address" }),
    /PERIHELION_ESCROW_ADDRESS must be a 0x-prefixed 20-byte EVM address/,
  );
});

test("loadConfig rejects a non-numeric PERIHELION_MIN_MARGIN_BPS", () => {
  assert.throws(
    () => loadConfig({ ...baseSolverEnv(), PERIHELION_MIN_MARGIN_BPS: "abc" }),
    /PERIHELION_MIN_MARGIN_BPS must be an integer between 0 and 10000/,
  );
});

test("loadConfig rejects a zero PERIHELION_POLL_INTERVAL_MS", () => {
  assert.throws(
    () => loadConfig({ ...baseSolverEnv(), PERIHELION_POLL_INTERVAL_MS: "0" }),
    /PERIHELION_POLL_INTERVAL_MS must be a positive integer/,
  );
});

test("loadConfig defaults mempoolUrl to the mempool's own default port", () => {
  const config = loadConfig(baseSolverEnv());
  assert.equal(config.mempoolUrl, "http://localhost:3000");
});

test("loadConfig returns a valid config when all required vars are present", () => {
  const config = loadConfig(baseSolverEnv());
  assert.equal(config.solverAddress, VALID_SOLVER);
  assert.equal(config.escrowAddress, VALID_ESCROW);
});

function baseExecutorEnv() {
  return {
    PERIHELION_EVM_RPC_URL: "http://localhost:8545",
    PERIHELION_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    PERIHELION_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    PERIHELION_SOROBAN_SECRET_KEY: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    PERIHELION_ESCROW_ADDRESS: VALID_ESCROW,
    PERIHELION_SETTLEMENT_CONTRACT_ID: "0".repeat(64),
    PERIHELION_SOURCE_CHAIN_ID: "8453",
  };
}

test("loadExecutorConfig throws a single consolidated error when required vars are missing", () => {
  assert.throws(
    () => loadExecutorConfig({}),
    /PERIHELION_EVM_RPC_URL is required[\s\S]*PERIHELION_SOROBAN_RPC_URL is required/,
  );
});

test("loadExecutorConfig rejects a malformed escrow address", () => {
  assert.throws(
    () =>
      loadExecutorConfig({ ...baseExecutorEnv(), PERIHELION_ESCROW_ADDRESS: "not-an-address" }),
    /PERIHELION_ESCROW_ADDRESS must be a 0x-prefixed 20-byte EVM address/,
  );
});

test("loadExecutorConfig rejects a non-positive source chain id", () => {
  assert.throws(
    () => loadExecutorConfig({ ...baseExecutorEnv(), PERIHELION_SOURCE_CHAIN_ID: "-1" }),
    /PERIHELION_SOURCE_CHAIN_ID must be a positive integer/,
  );
});

test("loadExecutorConfig returns a valid config when all required vars are present", () => {
  const config = loadExecutorConfig(baseExecutorEnv());
  assert.equal(config.escrowAddress.toLowerCase(), VALID_ESCROW);
  assert.equal(config.sourceChainId, 8453);
});
