/**
 * @perihelion/sdk — construct, sign, submit, and track Perihelion intents.
 *
 * @example
 * ```ts
 * import { PerihelionClient, buildIntent } from "@perihelion/sdk";
 *
 * const client = new PerihelionClient({
 *   mempoolUrl: "https://mempool.perihelion.xyz",
 *   chainId: 8453,
 *   verifyingContract: "0xYourEscrowAddress",
 * });
 * const intent = buildIntent({
 *   user: "0xabc...",
 *   destination: "GUSER...STELLAR",
 *   sourceChainId: 8453,            // Base
 *   sourceAsset: "0x833589...",     // USDC on Base
 *   sourceAmount: "1000000",        // 1 USDC (6 decimals)
 *   destAsset: "USDC:GA5Z...",      // USDC on Stellar
 *   minDestAmount: "9900000",       // accept >= 0.99 (7 decimals)
 *   deadline: Math.floor(Date.now() / 1000) + 600,
 * });
 *
 * const signed = await client.signIntent(wallet, intent);
 * const hash = await client.submitIntent(signed);
 * const result = await client.waitForSettlement(hash);
 * ```
 */

export * from "./types.js";
export * from "./intent.js";
export * from "./errors.js";
export * from "./client.js";
export * from "./units.js";
export * from "./stellar.js";
export * from "./validate.js";
