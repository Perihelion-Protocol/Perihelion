// SPDX-License-Identifier: MIT

/**
 * Static checks on docker-compose.yml. They parse the file rather than start
 * containers, so a misconfiguration fails in CI without a Docker daemon.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

type Service = {
  command?: string;
  environment?: Record<string, string | number>;
  healthcheck?: { test: string[] };
  depends_on?: Record<string, { condition: string }>;
};

const RAW = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const services = (yaml.load(RAW) as { services: Record<string, Service> }).services;

// `anvil` and the other services are looked up by name; a missing service
// should fail the test with a clear message rather than a TypeError.
function service(name: string): Service {
  const svc = services[name];
  assert.ok(svc, `docker-compose.yml has no "${name}" service`);
  return svc;
}

// `--local` makes the quickstart container create a standalone network, and
// that network's passphrase is fixed by Stellar Core.
const STANDALONE_PASSPHRASE = "Standalone Network ; February 2017";

test("stellar service uses the standalone passphrase its --local mode creates", () => {
  const stellar = service("stellar");
  assert.match(stellar.command ?? "", /--local/);
  assert.equal(stellar.environment?.STELLAR_NETWORK_PASSPHRASE, STANDALONE_PASSPHRASE);
});

test("relayer and solver sign for the same network the stellar service runs", () => {
  assert.equal(service("relayer").environment?.STELLAR_NETWORK, STANDALONE_PASSPHRASE);
  assert.equal(service("solver").environment?.STELLAR_NETWORK, STANDALONE_PASSPHRASE);
});

test("relayer and solver point Soroban RPC at the /rpc path", () => {
  assert.match(
    String(service("relayer").environment?.PERIHELION_STELLAR_RPC_URL),
    /^http:\/\/stellar:8000\/rpc$/,
  );
  assert.match(
    String(service("solver").environment?.PERIHELION_SOROBAN_RPC_URL),
    /^http:\/\/stellar:8000\/rpc$/,
  );
});

test("stellar healthcheck probes getHealth without relying on node", () => {
  const check = service("stellar").healthcheck?.test ?? [];
  const probe = check.join(" ");
  assert.match(probe, /getHealth/);
  assert.match(probe, /curl/);
  assert.ok(!check.includes("node"), "stellar/quickstart does not ship Node.js");
});

test("mempool inherits the image's /healthz healthcheck instead of overriding it", () => {
  assert.equal(service("mempool").healthcheck, undefined);
});

test("relayer and solver wait for a healthy mempool, not just a started container", () => {
  for (const name of ["relayer", "solver"]) {
    assert.equal(service(name).depends_on?.mempool?.condition, "service_healthy", name);
  }
});

// Local placeholders. 30101 and 40161 are real LayerZero V2 endpoint ids
// (Ethereum mainnet and Sepolia); the development stack must not use them.
const LOCAL_EVM_EID = 31337;
const LOCAL_STELLAR_EID = 99161;

test("relayer uses local placeholder endpoint ids, not real LayerZero ones", () => {
  const env = service("relayer").environment;
  assert.equal(env?.PERIHELION_SOURCE_EID, LOCAL_EVM_EID);
  assert.equal(env?.PERIHELION_STELLAR_EID, LOCAL_STELLAR_EID);
});

// Required interpolation: `${VAR:?message}` fails `docker compose` when VAR is
// unset. A `:-default` would silently fall back to a value that is not deployed.
const REQUIRED = /^\$\{[A-Z_]+:\?.+\}$/;

test("escrow address is required, not defaulted to an Anvil account", () => {
  for (const name of ["mempool", "relayer", "solver"]) {
    const value = String(service(name).environment?.PERIHELION_ESCROW_ADDRESS);
    assert.match(value, REQUIRED, name);
  }
});

test("settlement contract ids are required, not hard-coded to an undeployed contract", () => {
  assert.match(String(service("relayer").environment?.PERIHELION_SETTLEMENT_CONTRACT), REQUIRED);
  assert.match(String(service("solver").environment?.PERIHELION_SETTLEMENT_CONTRACT_ID), REQUIRED);
  assert.doesNotMatch(RAW, /CA7QYNF7SOWQ3GLR4CIDVXIUCMEOBEEUHW5C33ATIO5Q5TR3LYAQHRJS/);
});
