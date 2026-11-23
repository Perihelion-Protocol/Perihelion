// SPDX-License-Identifier: MIT
// solver/src/escrow-terminal-source.ts
//
// viem-backed implementation of {@link EscrowTerminalSource}: reads the
// PerihelionEscrow `Released`, `Refunded` and `RefundedLocalTimeout` events
// for a block range with `getLogs`.

import { createPublicClient, getAbiItem, http, type Hex, type PublicClient } from "viem";
import { ESCROW_ABI } from "@perihelion/sdk";

import type { EscrowTerminalSource, TerminalEvent, TerminalEventKind } from "./released-watcher.js";

const TERMINAL_EVENTS = (["Released", "Refunded", "RefundedLocalTimeout"] as const).map(
  (name) => getAbiItem({ abi: ESCROW_ABI, name }),
);

export class ViemTerminalEventSource implements EscrowTerminalSource {
  constructor(
    private readonly client: PublicClient,
    private readonly escrowAddress: `0x${string}`,
  ) {}

  /** Builds a source that talks to the escrow over an HTTP RPC endpoint. */
  static fromRpcUrl(rpcUrl: string, escrowAddress: `0x${string}`): ViemTerminalEventSource {
    return new ViemTerminalEventSource(
      createPublicClient({ transport: http(rpcUrl) }),
      escrowAddress,
    );
  }

  async getBlockNumber(): Promise<number> {
    return Number(await this.client.getBlockNumber());
  }

  async getTerminalEvents(fromBlock: number, toBlock: number): Promise<TerminalEvent[]> {
    const logs = await this.client.getLogs({
      address: this.escrowAddress,
      events: TERMINAL_EVENTS,
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });

    const events: TerminalEvent[] = logs.map((log) => ({
      kind: log.eventName as TerminalEventKind,
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
