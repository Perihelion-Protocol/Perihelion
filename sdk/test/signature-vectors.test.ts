/**
 * Signature test-vector conformance for the TypeScript verifier (verifyIntent).
 *
 * Loads the shared signature-vectors.json from contracts/shared/wire-vectors/ and
 * asserts that every vector produces the expected accept/reject result.  This test
 * is the TypeScript half of the cross-implementation vector contract; the Solidity
 * half lives in contracts/evm/test/SignatureVectors.t.sol.
 *
 * Vectors cover:
 *   - valid canonical signature (must accept)
 *   - wrong signer (must reject)
 *   - high-s malleable signature (must reject — EIP-2 / low-s enforcement)
 *   - truncated 64-byte signature (must reject)
 *   - over-length 66-byte signature (must reject)
 *   - bad v value (v=29, must reject)
 *   - cross-chain domain mismatch (must reject)
 *   - wrong verifyingContract domain mismatch (must reject)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import { verifyIntent, perihelionDomain } from "../src/intent.js";
import type { Intent, Hex } from "../src/types.js";

// ─── Load vectors ────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = path.resolve(
  __dirname,
  "../../contracts/shared/wire-vectors/signature-vectors.json"
);

interface SigVectorFile {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  intent: {
    user: string;
    destination: string;
    sourceChainId: number;
    sourceAsset: string;
    sourceAmount: string;
    destAsset: string;
    minDestAmount: string;
    deadline: number;
    nonce: string;
    preferredSolver: string;
  };
  intentHash: string;
  vectors: Array<{
    id: string;
    description: string;
    signature: string;
    expectedResult: "accept" | "reject";
  }>;
}

const file: SigVectorFile = JSON.parse(readFileSync(VECTORS_PATH, "utf-8"));

const domain = perihelionDomain(
  file.domain.chainId,
  file.domain.verifyingContract as `0x${string}`
);

const intent: Intent = {
  user:            file.intent.user as `0x${string}`,
  destination:     file.intent.destination,
  sourceChainId:   file.intent.sourceChainId,
  sourceAsset:     file.intent.sourceAsset as `0x${string}`,
  sourceAmount:    file.intent.sourceAmount,
  destAsset:       file.intent.destAsset,
  minDestAmount:   file.intent.minDestAmount,
  deadline:        file.intent.deadline,
  nonce:           file.intent.nonce,
  preferredSolver: file.intent.preferredSolver as `0x${string}`,
};

// ─── Run one test per vector ──────────────────────────────────────────────────

for (const vector of file.vectors) {
  test(`sig-vector [${vector.id}]: ${vector.description}`, async () => {
    const sig = vector.signature as Hex;
    let result: boolean;
    try {
      // verifyIntent may throw if the signature is fundamentally malformed
      // (e.g. wrong length before ecrecover). Treat any throw as "reject".
      result = await verifyIntent(intent, sig, domain);
    } catch {
      result = false;
    }

    if (vector.expectedResult === "accept") {
      assert.equal(
        result,
        true,
        `vector '${vector.id}' should be accepted but verifyIntent returned false`
      );
    } else {
      assert.equal(
        result,
        false,
        `vector '${vector.id}' should be rejected but verifyIntent returned true`
      );
    }
  });
}
