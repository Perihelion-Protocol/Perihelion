// SPDX-License-Identifier: MIT
// solver/src/escrow-released-source.ts
//
// viem-backed implementation of {@link EscrowReleasedSource}: reads the
// PerihelionEscrow `Released` event for a block range with `getLogs`.

import { createPublicClient, getAbiItem, http, type Hex, type PublicClient } from "viem";
import { ESCROW_ABI } from "@perihelion/sdk";

import type { EscrowReleasedSource, ReleasedEvent } from "./released-watcher.js";

const RELEASED_EVENT = getAbiItem({ abi: ESCROW_ABI, name: "Released" });

export class ViemReleasedEventSource implements EscrowReleasedSource {
  constructor(
    private readonly client: PublicClient,
    private readonly escrowAddress: `0x${string}`,
  ) {}

  /** Builds a source that talks to the escrow over an HTTP RPC endpoint. */
  static fromRpcUrl(rpcUrl: string, escrowAddress: `0x${string}`): ViemReleasedEventSource {
    return new ViemReleasedEventSource(
      createPublicClient({ transport: http(rpcUrl) }),
      escrowAddress,
    );
  }

  async getBlockNumber(): Promise<number> {
    return Number(await this.client.getBlockNumber());
  }

  async getReleasedEvents(fromBlock: number, toBlock: number): Promise<ReleasedEvent[]> {
    const logs = await this.client.getLogs({
      address: this.escrowAddress,
      event: RELEASED_EVENT,
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });

    const events: ReleasedEvent[] = logs.map((log) => ({
      intentHash: (log.args as { intentHash: Hex }).intentHash,
      blockNumber: Number(log.blockNumber ?? 0n),
      transactionHash: log.transactionHash ?? "0x",
      logIndex: log.logIndex ?? 0,
    }));

    return events.sort((a, b) =>
      a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex,
    );
  }
}
