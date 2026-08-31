// SPDX-License-Identifier: MIT

import { MempoolServer } from "./index.js";
import type { Address } from "@perihelion/sdk";

const port = parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.PERIHELION_MEMPOOL_HOST ?? "localhost";

/**
 * Reads an optional positive-integer environment variable. An unset or empty
 * value yields `undefined` (the server falls back to its documented default);
 * a value that is not a positive integer is a startup error rather than a
 * silently-ignored typo.
 */
function optionalPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

if (!process.env.PERIHELION_SOURCE_CHAIN_ID) {
  throw new Error("PERIHELION_SOURCE_CHAIN_ID is required to start the mempool.");
}
if (!process.env.PERIHELION_ESCROW_ADDRESS) {
  throw new Error("PERIHELION_ESCROW_ADDRESS is required to start the mempool.");
}

const chainId = Number(process.env.PERIHELION_SOURCE_CHAIN_ID);
const verifyingContract = process.env.PERIHELION_ESCROW_ADDRESS as Address;
const statusToken = process.env.PERIHELION_MEMPOOL_STATUS_TOKEN;
const server = new MempoolServer({
  port,
  host,
  chainId,
  verifyingContract,
  statusToken,
  maxStoreSize: optionalPositiveInt("PERIHELION_MEMPOOL_MAX_STORE_SIZE"),
  expiryGraceMs: optionalPositiveInt("PERIHELION_MEMPOOL_EXPIRY_GRACE_MS"),
  rateLimitWindowMs: optionalPositiveInt("PERIHELION_MEMPOOL_RATE_LIMIT_WINDOW_MS"),
  writeRateLimit: optionalPositiveInt("PERIHELION_MEMPOOL_WRITE_RATE_LIMIT"),
  readRateLimit: optionalPositiveInt("PERIHELION_MEMPOOL_READ_RATE_LIMIT"),
});

await server.start();
