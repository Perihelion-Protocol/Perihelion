// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEPLOYMENTS,
  getEscrowAddress,
  tryGetEscrowAddress,
} from "../src/deployments.js";

test("DEPLOYMENTS", async (t) => {
  await t.test("is a readonly object", () => {
    assert.equal(typeof DEPLOYMENTS, "object");
    // Verify it's frozen (readonly)
    assert.equal(Object.isFrozen(DEPLOYMENTS), true);
  });

  await t.test("is initially empty", () => {
    assert.equal(Object.keys(DEPLOYMENTS).length, 0);
  });
});

test("getEscrowAddress", async (t) => {
  await t.test("throws UndeployedChainError for undeployed chain", () => {
    assert.throws(
      () => getEscrowAddress(8453),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.equal(err.name, "UndeployedChainError");
        assert.match(err.message, /Chain 8453 is not deployed/);
        assert.match(err.message, /docs\/deployment.md/);
        return true;
      }
    );
  });

  await t.test("throws with descriptive error naming the chain", () => {
    assert.throws(
      () => getEscrowAddress(42161),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.match(err.message, /Chain 42161/);
        return true;
      }
    );
  });

  await t.test("throws for chain 1 (Ethereum)", () => {
    assert.throws(
      () => getEscrowAddress(1),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.equal(err.name, "UndeployedChainError");
        assert.match(err.message, /Chain 1/);
        return true;
      }
    );
  });

  await t.test("throws for chain 0 (invalid)", () => {
    assert.throws(
      () => getEscrowAddress(0),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.equal(err.name, "UndeployedChainError");
        return true;
      }
    );
  });

  await t.test("throws for negative chain ID", () => {
    assert.throws(
      () => getEscrowAddress(-1),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.equal(err.name, "UndeployedChainError");
        return true;
      }
    );
  });
});

test("tryGetEscrowAddress", async (t) => {
  await t.test("returns undefined for undeployed chain", () => {
    const result = tryGetEscrowAddress(8453);
    assert.equal(result, undefined);
  });

  await t.test("returns undefined for any chain when none deployed", () => {
    assert.equal(tryGetEscrowAddress(1), undefined);
    assert.equal(tryGetEscrowAddress(42161), undefined);
    assert.equal(tryGetEscrowAddress(10), undefined);
  });

  await t.test("does not throw", () => {
    assert.doesNotThrow(() => {
      tryGetEscrowAddress(8453);
    });
  });
});

test("integration: getEscrowAddress vs tryGetEscrowAddress", async (t) => {
  await t.test(
    "getEscrowAddress throws while tryGetEscrowAddress returns undefined",
    () => {
      const chainId = 8453;
      // getEscrowAddress throws
      assert.throws(() => getEscrowAddress(chainId));
      // tryGetEscrowAddress returns undefined
      assert.equal(tryGetEscrowAddress(chainId), undefined);
    }
  );

  await t.test("error message guides user to docs", () => {
    assert.throws(
      () => getEscrowAddress(999),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.match(err.message, /docs\/deployment\.md/);
        return true;
      }
    );
  });
});
