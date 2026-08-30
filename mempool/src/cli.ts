// SPDX-License-Identifier: MIT

import { MempoolServer } from "./index.js";
import type { Address } from "@perihelion/sdk";

const port = parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.PERIHELION_MEMPOOL_HOST ?? "localhost";

if (!process.env.PERIHELION_SOURCE_CHAIN_ID) {
  throw new Error("PERIHELION_SOURCE_CHAIN_ID is required to start the mempool.");
}
if (!process.env.PERIHELION_ESCROW_ADDRESS) {
  throw new Error("PERIHELION_ESCROW_ADDRESS is required to start the mempool.");
}

const chainId = Number(process.env.PERIHELION_SOURCE_CHAIN_ID);
const verifyingContract = process.env.PERIHELION_ESCROW_ADDRESS as Address;
const statusToken = process.env.PERIHELION_MEMPOOL_STATUS_TOKEN;

/**
 * Parse PERIHELION_MEMPOOL_TRUST_PROXY into the shape Express's `trust proxy`
 * setting accepts: a hop count (`"1"`), a boolean (`"true"`/`"false"`), or a
 * preset / comma-separated subnet list (`"loopback"`, `"10.0.0.0/8"`). Unset
 * means "not behind a proxy" — the safe default. See mempool/README.md.
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber >= 0) return asNumber;
  return raw;
}

const trustProxy = parseTrustProxy(process.env.PERIHELION_MEMPOOL_TRUST_PROXY);
const server = new MempoolServer({ port, host, chainId, verifyingContract, statusToken, trustProxy });

await server.start();
