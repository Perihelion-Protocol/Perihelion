// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EvmDestinationDelivery,
  messageGuid,
  type EvmDestinationDeliveryConfig,
} from "../src/evm-delivery.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}` as const;
const ENDPOINT = "0x1111111111111111111111111111111111111111" as const;
const ESCROW = "0x2222222222222222222222222222222222222222" as const;
const SRC_SENDER = `0x${"ab".repeat(32)}` as const;

function validConfig(overrides: Partial<EvmDestinationDeliveryConfig> = {}): EvmDestinationDeliveryConfig {
  return {
    rpcUrl: "http://127.0.0.1:8545",
    privateKey: PRIVATE_KEY,
    escrowAddress: ESCROW,
    mockEndpointAddress: ENDPOINT,
    srcEid: 40_000,
    srcSender: SRC_SENDER,
    ...overrides,
  };
}

describe("EvmDestinationDelivery config validation", () => {
  it("accepts a complete config", () => {
    assert.doesNotThrow(() => new EvmDestinationDelivery(validConfig()));
  });

  it("rejects a missing endpoint address", () => {
    const config = validConfig({ mockEndpointAddress: undefined as unknown as typeof ENDPOINT });
    assert.throws(() => new EvmDestinationDelivery(config), /mockEndpointAddress/);
  });

  it("rejects a missing or zero srcEid", () => {
    assert.throws(
      () => new EvmDestinationDelivery(validConfig({ srcEid: undefined as unknown as number })),
      /srcEid/,
    );
    assert.throws(() => new EvmDestinationDelivery(validConfig({ srcEid: 0 })), /srcEid/);
  });

  it("rejects a missing or all-zero srcSender", () => {
    assert.throws(
      () => new EvmDestinationDelivery(validConfig({ srcSender: undefined as unknown as typeof SRC_SENDER })),
      /srcSender/,
    );
    assert.throws(
      () => new EvmDestinationDelivery(validConfig({ srcSender: `0x${"00".repeat(32)}` as typeof SRC_SENDER })),
      /srcSender/,
    );
  });
});

describe("messageGuid", () => {
  const BODY_A = "0x0102030405";
  const BODY_B = "0x0102030406";

  it("returns a 32-byte hash", () => {
    assert.match(messageGuid("FillConfirmed", BODY_A), /^0x[0-9a-f]{64}$/);
  });

  it("gives distinct GUIDs for distinct payloads", () => {
    assert.notEqual(messageGuid("FillConfirmed", BODY_A), messageGuid("FillConfirmed", BODY_B));
  });

  it("gives distinct GUIDs for the same body under different message types", () => {
    assert.notEqual(messageGuid("FillConfirmed", BODY_A), messageGuid("CancelIntent", BODY_A));
  });

  it("is deterministic", () => {
    assert.equal(messageGuid("CancelIntent", BODY_A), messageGuid("CancelIntent", BODY_A));
  });
});
