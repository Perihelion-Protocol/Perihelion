import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { baseConfig, requiredConfigKeys, validConfig } from "./fixtures.js";

test("loadConfig succeeds with valid required fields and applies defaults", () => {
  const config = loadConfig(baseConfig());
  assert.ok(config);
});

test("loadConfig requires the complete set of required variables", () => {
  for (const key of requiredConfigKeys) {
    assert.ok(
      key in validConfig,
      `fixture is missing required variable ${key}; update relayer/test/fixtures.ts`,
    );
  }
  assert.deepEqual(
    Object.keys(validConfig).sort(),
    [...requiredConfigKeys].sort(),
    "fixture must define exactly the required variables; update relayer/test/fixtures.ts",
  );
});

test("loadConfig rejects a missing required variable", () => {
  const { PERIHELION_EVM_RPC_URL: _omit, ...rest } = baseConfig();
  assert.throws(() => loadConfig(rest), /PERIHELION_EVM_RPC_URL/);
});
