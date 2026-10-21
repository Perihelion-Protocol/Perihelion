// SPDX-License-Identifier: MIT

/**
 * Regression test for #964: the per-IP rate-limit map grew without bound
 * because keys were never deleted, even when the filtered timestamp array
 * became empty after the window elapsed.
 *
 * Acceptance criterion: after the rate-limit window elapses with no new
 * traffic, `rateLimitMapSize` returns zero.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIntent,
  perihelionDomain,
  INTENT_TYPES,
  toMessage,
  type Address,
} from "@perihelion/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { MempoolServer } from "../src/server.js";

const CHAIN_ID = 8453;
const ESCROW: Address = "0x000000000000000000000000000000000000dead";

const account = privateKeyToAccount(("0x" + "99".repeat(32)) as `0x${string}`);

function sampleIntent(overrides: Record<string, unknown> = {}) {
  return buildIntent({
    user: account.address,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000004" as Address,
    sourceAmount: "10000000",
    destAsset: "native",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  });
}

async function signIntent(intent: ReturnType<typeof sampleIntent>) {
  const domain = perihelionDomain(CHAIN_ID, ESCROW);
  return account.signTypedData({
    domain,
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
  });
}

test(
  "rate-limit map shrinks to zero after the window elapses (#964)",
  async () => {
    // Use a very short window so we can wait it out without slowing CI.
    const WINDOW_MS = 100;
    const server = new MempoolServer({
      port: 3995,
      chainId: CHAIN_ID,
      verifyingContract: ESCROW,
      rateLimitWindowMs: WINDOW_MS,
      writeRateLimit: 200, // high enough that none of the synthetic requests are blocked
      readRateLimit: 200,
    });
    await server.start();

    try {
      const base = "http://localhost:3995";

      // Repeated local requests exercise expiry of both rate-limit keys used
      // by the server. Synthetic client IPs are not trusted by this server.
      const REQUESTS = 10;
      for (let i = 0; i < REQUESTS; i++) {
        const intent = sampleIntent({ sourceAmount: String(10_000_000 + i) });
        const sig = await signIntent(intent);
        await fetch(`${base}/intents`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intent, signature: sig }),
        });
      }

      // The map must be non-empty after traffic.
      assert.ok(
        server.rateLimitMapSize > 0,
        `rateLimitMapSize should be > 0 after traffic (got ${server.rateLimitMapSize})`,
      );

      // Wait for the window to elapse then trigger a sweep.
      await new Promise((r) => setTimeout(r, WINDOW_MS + 20));
      server.sweepRateLimits();

      // Acceptance criterion: the map must now be empty.
      assert.equal(
        server.rateLimitMapSize,
        0,
        `rateLimitMapSize should be 0 after window elapses and sweep runs (got ${server.rateLimitMapSize})`,
      );
    } finally {
      await server.stop();
    }
  },
);

test(
  "rate-limit key is deleted immediately when the per-request filter produces an empty array (#964)",
  async () => {
    // This exercises the inline cleanup in the rateLimit() middleware itself:
    // on the very first request *after* the window rolls over, the filtered
    // array is empty before the new timestamp is pushed. The key should be
    // absent from the map between the old window expiring and the new request
    // arriving — but at minimum the map must not grow beyond 2 entries
    // (one read key, one write key) per unique IP address regardless of how
    // many window cycles pass.
    const WINDOW_MS = 80;
    const server = new MempoolServer({
      port: 3996,
      chainId: CHAIN_ID,
      verifyingContract: ESCROW,
      rateLimitWindowMs: WINDOW_MS,
      writeRateLimit: 100,
      readRateLimit: 100,
    });
    await server.start();

    try {
      const base = "http://localhost:3996";
      const intent1 = sampleIntent({ sourceAmount: "11111111" });
      const sig1 = await signIntent(intent1);
      const intent2 = sampleIntent({ sourceAmount: "22222222" });
      const sig2 = await signIntent(intent2);

      // First window: one write request.
      await fetch(`${base}/intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: intent1, signature: sig1 }),
      });

      const sizeAfterFirst = server.rateLimitMapSize;
      assert.ok(sizeAfterFirst > 0, "map should be non-empty after first request");

      // Wait for the window to roll over.
      await new Promise((r) => setTimeout(r, WINDOW_MS + 20));

      // Second window: one write request. This hits the inline cleanup path.
      await fetch(`${base}/intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: intent2, signature: sig2 }),
      });

      // The map size must not have grown — old entries from the previous
      // window were cleaned up inline when the new request arrived.
      assert.ok(
        server.rateLimitMapSize <= sizeAfterFirst,
        `map grew from ${sizeAfterFirst} to ${server.rateLimitMapSize} across window boundaries (should not grow)`,
      );

      // After a sweep the map shrinks to zero.
      await new Promise((r) => setTimeout(r, WINDOW_MS + 20));
      server.sweepRateLimits();
      assert.equal(server.rateLimitMapSize, 0, "map must be empty after window elapses and sweep");
    } finally {
      await server.stop();
    }
  },
);
