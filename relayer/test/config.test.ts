import { test } from "node:test";
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { REQUIRED_CONFIG_VARS, VALID_SIGNER_SECRET, validConfigEnv } from "./fixtures.js";

test("loadConfig succeeds with valid required fields and applies defaults", () => {
  const config = loadConfig(validConfigEnv());
  assert.ok(config);
});

test("loadConfig requires the complete set of required variables", () => {
  const env = validConfigEnv();
  for (const key of REQUIRED_CONFIG_VARS) {
    assert.ok(
      key in env,
      `fixture is missing required variable ${key}; update relayer/test/fixtures.ts`,
    );
  }
  assert.deepEqual(
    Object.keys(env).sort(),
    [...REQUIRED_CONFIG_VARS].sort(),
    "fixture must define exactly the required variables; update relayer/test/fixtures.ts",
  );
});

test("loadConfig rejects a missing required variable", () => {
  const { PERIHELION_EVM_RPC_URL: _omit, ...rest } = validConfigEnv();
  assert.throws(() => loadConfig(rest), /PERIHELION_EVM_RPC_URL/);
});
test("loadConfig applies health, readiness and state-file defaults", () => {
  const config = loadConfig(validConfigEnv());
  assert.equal(config.healthPort, 8080);
  assert.equal(config.healthHost, "127.0.0.1");
  assert.equal(config.metricsToken, undefined);
  assert.equal(config.readinessStaleMs, config.pollIntervalMs * 3);
  assert.equal(config.maxLagBlocks, 500);
  assert.equal(config.checkpointFile, "./.perihelion-relayer-checkpoint.json");
  assert.equal(config.deadLetterFile, "./.perihelion-relayer-dead-letter.json");
});

test("loadConfig reads health, readiness and state-file overrides", () => {
  const config = loadConfig({
    ...validConfigEnv(),
    PERIHELION_HEALTH_PORT: "9001",
    PERIHELION_HEALTH_HOST: "0.0.0.0",
    PERIHELION_METRICS_TOKEN: "secret",
    PERIHELION_READINESS_STALE_MS: "20000",
    PERIHELION_MAX_LAG_BLOCKS: "42",
    PERIHELION_CHECKPOINT_FILE: "/var/lib/perihelion/checkpoint.json",
    PERIHELION_DEAD_LETTER_FILE: "/var/lib/perihelion/dead-letter.json",
  });
  assert.equal(config.healthPort, 9001);
  assert.equal(config.healthHost, "0.0.0.0");
  assert.equal(config.metricsToken, "secret");
  assert.equal(config.readinessStaleMs, 20_000);
  assert.equal(config.maxLagBlocks, 42);
  assert.equal(config.checkpointFile, "/var/lib/perihelion/checkpoint.json");
  assert.equal(config.deadLetterFile, "/var/lib/perihelion/dead-letter.json");
});

test("loadConfig defaults the relayer mode to dev", () => {
  const config = loadConfig(validConfigEnv());
  assert.equal(config.relayerMode, "dev");
});

test("loadConfig rejects dev mode against Pubnet without an explicit override", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validConfigEnv(),
        STELLAR_NETWORK: "Public Global Stellar Network ; September 2015",
      }),
    /PERIHELION_RELAYER_MODE/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...validConfigEnv(),
        STELLAR_NETWORK: "Public Global Stellar Network ; September 2015",
        PERIHELION_RELAYER_MODE: "dev",
      }),
    /PERIHELION_RELAYER_MODE/,
  );
});

test("loadConfig permits dev mode against Pubnet with the explicit override", () => {
  const config = loadConfig({
    ...validConfigEnv(),
    STELLAR_NETWORK: "Public Global Stellar Network ; September 2015",
    PERIHELION_RELAYER_MODE: "dev",
    PERIHELION_ALLOW_ENDPOINT_IMPERSONATION: "true",
  });
  assert.equal(config.relayerMode, "dev");
});

test("loadConfig rejects malformed health and readiness settings, naming each variable", () => {
  const cases: Array<[string, string]> = [
    ["PERIHELION_HEALTH_PORT", "abc"],
    ["PERIHELION_HEALTH_PORT", "70000"],
    ["PERIHELION_READINESS_STALE_MS", "-1"],
    ["PERIHELION_MAX_LAG_BLOCKS", "1.5"],
  ];
  for (const [key, value] of cases) {
    assert.throws(
      () => loadConfig({ ...validConfigEnv(), [key]: value }),
      new RegExp(key),
      `${key}=${value} must be rejected`,
    );
  }
});

// --- Strict integer and signer validation (#978) -----------------------------

function errorFor(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (err) {
    return (err as Error).message;
  }
  assert.fail("loadConfig was expected to throw");
}

test("loadConfig rejects fractional endpoint ids and names the variable", () => {
  assert.match(
    errorFor({ ...validConfigEnv(), PERIHELION_SOURCE_EID: "1.5" }),
    /PERIHELION_SOURCE_EID/,
  );
  assert.match(
    errorFor({ ...validConfigEnv(), PERIHELION_STELLAR_EID: "40161.0" }),
    /PERIHELION_STELLAR_EID/,
  );
});

test("loadConfig rejects endpoint ids outside uint32", () => {
  assert.match(
    errorFor({ ...validConfigEnv(), PERIHELION_SOURCE_EID: "4294967296" }),
    /PERIHELION_SOURCE_EID/,
  );
  assert.match(
    errorFor({ ...validConfigEnv(), PERIHELION_STELLAR_EID: "-1" }),
    /PERIHELION_STELLAR_EID/,
  );
});

test("loadConfig accepts the largest uint32 endpoint id", () => {
  const config = loadConfig({ ...validConfigEnv(), PERIHELION_SOURCE_EID: "4294967295" });
  assert.equal(config.sourceEid, 4294967295);
});

test("loadConfig rejects fractional start block and poll interval", () => {
  assert.match(
    errorFor({ ...validConfigEnv(), PERIHELION_START_BLOCK: "10.5" }),
    /PERIHELION_START_BLOCK/,
  );
  assert.match(
    errorFor({ ...validConfigEnv(), PERIHELION_POLL_INTERVAL_MS: "1000.5" }),
    /PERIHELION_POLL_INTERVAL_MS/,
  );
  assert.match(
    errorFor({ ...validConfigEnv(), PERIHELION_POLL_INTERVAL_MS: "0" }),
    /PERIHELION_POLL_INTERVAL_MS/,
  );
});

test("loadConfig rejects a signer secret with a bad checksum", () => {
  const secret = VALID_SIGNER_SECRET;
  const last = secret[secret.length - 1];
  const tampered = secret.slice(0, -1) + (last === "A" ? "B" : "A");
  assert.match(errorFor({ ...validConfigEnv(), SIGNER_SECRET: tampered }), /SIGNER_SECRET/);
});

// --- Keeper mode and PERIHELION_KEEPER_* settings (#1123) --------------------

test("loadConfig accepts PERIHELION_RELAYER_MODE=keeper (including on Pubnet without impersonation override)", () => {
  const config = loadConfig({
    ...validConfigEnv(),
    STELLAR_NETWORK: "Public Global Stellar Network ; September 2015",
    PERIHELION_RELAYER_MODE: "keeper",
  });
  assert.equal(config.relayerMode, "keeper");
  assert.equal(config.keeperDryRun, false);
  assert.equal(config.keeperEnforceProfitability, true);
  assert.equal(config.keeperMinProfitStroops, 0n);
  assert.equal(config.keeperLzFeeBufferStroops, 0n);
  assert.equal(config.evmPrivateKey, undefined);
  assert.equal(config.keeperMaxGasPriceWei, undefined);
  assert.equal(config.keeperMaxEvmCancelCostWei, undefined);
});

test("loadConfig parses all PERIHELION_KEEPER_* and PERIHELION_EVM_PRIVATE_KEY environment variables", () => {
  const evmKey = "0x" + "ab".repeat(32);
  const config = loadConfig({
    ...validConfigEnv(),
    PERIHELION_RELAYER_MODE: "keeper",
    PERIHELION_EVM_PRIVATE_KEY: evmKey,
    PERIHELION_KEEPER_DRY_RUN: "true",
    PERIHELION_KEEPER_ENFORCE_PROFITABILITY: "false",
    PERIHELION_KEEPER_MIN_PROFIT_STROOPS: "25000",
    PERIHELION_KEEPER_MAX_GAS_PRICE_WEI: "20000000000",
    PERIHELION_KEEPER_MAX_EVM_CANCEL_COST_WEI: "2000000000000000",
    PERIHELION_KEEPER_LZ_FEE_BUFFER_STROOPS: "5000",
  });

  assert.equal(config.relayerMode, "keeper");
  assert.equal(config.evmPrivateKey, evmKey);
  assert.equal(config.keeperDryRun, true);
  assert.equal(config.keeperEnforceProfitability, false);
  assert.equal(config.keeperMinProfitStroops, 25_000n);
  assert.equal(config.keeperMaxGasPriceWei, 20_000_000_000n);
  assert.equal(config.keeperMaxEvmCancelCostWei, 2_000_000_000_000_000n);
  assert.equal(config.keeperLzFeeBufferStroops, 5_000n);
});

test("loadConfig rejects malformed PERIHELION_RELAYER_MODE and PERIHELION_KEEPER_* variables", () => {
  assert.match(
    errorFor({ ...validConfigEnv(), PERIHELION_RELAYER_MODE: "unknown" }),
    /PERIHELION_RELAYER_MODE/,
  );
  assert.match(
    errorFor({ ...validConfigEnv(), PERIHELION_EVM_PRIVATE_KEY: "0x1234" }),
    /PERIHELION_EVM_PRIVATE_KEY/,
  );
  assert.match(
    errorFor({ ...validConfigEnv(), PERIHELION_KEEPER_MAX_GAS_PRICE_WEI: "-1" }),
    /PERIHELION_KEEPER_MAX_GAS_PRICE_WEI/,
  );
  assert.match(
    errorFor({ ...validConfigEnv(), PERIHELION_KEEPER_MAX_EVM_CANCEL_COST_WEI: "abc" }),
    /PERIHELION_KEEPER_MAX_EVM_CANCEL_COST_WEI/,
  );
  assert.match(
    errorFor({ ...validConfigEnv(), PERIHELION_KEEPER_LZ_FEE_BUFFER_STROOPS: "-5" }),
    /PERIHELION_KEEPER_LZ_FEE_BUFFER_STROOPS/,
  );
});
