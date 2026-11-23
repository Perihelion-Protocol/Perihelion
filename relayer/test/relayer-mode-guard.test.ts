// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, PUBNET_PASSPHRASE } from "../src/config.js";
import { validConfigEnv } from "./fixtures.js";

const pubnetEnv = () => ({ ...validConfigEnv(), STELLAR_NETWORK: PUBNET_PASSPHRASE });

test("Pubnet with no PERIHELION_RELAYER_MODE set refuses to start", () => {
  assert.throws(() => loadConfig(pubnetEnv()), /refusing to start against Pubnet/);
});

test("Pubnet with executor mode refuses with 'not implemented'", () => {
  assert.throws(
    () => loadConfig({ ...pubnetEnv(), PERIHELION_RELAYER_MODE: "executor" }),
    /executor is not implemented/,
  );
});

test("executor mode is rejected on testnet too, rather than being a no-op", () => {
  assert.throws(
    () => loadConfig({ ...validConfigEnv(), PERIHELION_RELAYER_MODE: "executor" }),
    /executor is not implemented/,
  );
});

test("the single override PERIHELION_ALLOW_ENDPOINT_IMPERSONATION permits Pubnet dev mode", () => {
  const config = loadConfig({
    ...pubnetEnv(),
    PERIHELION_ALLOW_ENDPOINT_IMPERSONATION: "true",
  });
  assert.equal(config.relayerMode, "dev");
  assert.equal(config.allowEndpointImpersonation, true);
});

test("the retired PERIHELION_ALLOW_PUBNET_DEV_RELAYER no longer overrides the guard", () => {
  assert.throws(
    () => loadConfig({ ...pubnetEnv(), PERIHELION_ALLOW_PUBNET_DEV_RELAYER: "1" }),
    /refusing to start against Pubnet/,
  );
});
