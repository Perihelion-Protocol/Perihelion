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
const server = new MempoolServer({ port, host, chainId, verifyingContract, statusToken });

await server.start();
