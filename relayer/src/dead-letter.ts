/**
 * Dead-letter store for persistently-failing bridge messages.
 *
 * When a message exhausts its retry budget it is moved here and an alertable
 * log entry is emitted. Operators can inspect the dead-letter queue, fix the
 * root cause (e.g. a misconfigured peer, a destination-side revert), and
 * requeue entries via the `drain` method.
 *
 * ## Operator runbook
 *
 * 1. **Alert fires** — the relayer emits a structured `DEAD_LETTER` log at
 *    `error` level with `{ intentHash, messageType, srcEid, dstEid, nonce,
 *    attempts, lastError }`.  Wire your log aggregator (CloudWatch, Datadog,
 *    etc.) to alert on `level=error msg=DEAD_LETTER`.
 *
 * 2. **Diagnose** — common causes:
 *    - Destination-side revert: check `lastError` for a contract revert reason.
 *      The settlement contract may already have the intent in a terminal state;
 *      if so the message is safe to discard via `discard(key)`.
 *    - Misconfigured peer / LayerZero path: check `PERIHELION_ESCROW_ADDRESS`
 *      and `PERIHELION_SETTLEMENT_CONTRACT` match the deployed contracts.
 *    - RPC outage: temporary; call `drain()` once the RPC recovers.
 *    - Malformed payload: inspect `pending.message`; if the on-chain event was
 *      genuinely malformed, discard and file a protocol bug report.
 *
 * 3. **Remediate**:
 *    - To retry all dead-lettered messages: call `drain()` on the store —
 *      `Relayer` will attempt delivery on the next tick.
 *    - To retry a single message: call `requeue(key)`.
 *    - To permanently discard: call `discard(key)` after confirming the intent
 *      reached a terminal state on-chain.
 *
 * 4. **Escalate** — if the same message repeatedly dead-letters after drain,
 *    escalate to the protocol team with the full `lastError` and the source
 *    transaction hash (`srcTxHash`).
 */

import type { PendingMessage } from "./types.js";
import type { MessageKey } from "./types.js";
import { messageKeyString } from "./types.js";

export interface DeadLetterEntry {
  readonly key: MessageKey;
  readonly pending: PendingMessage;
  readonly attempts: number;
  readonly lastError: string;
  readonly deadLetteredAt: number; // Unix ms
}

export interface DeadLetterStore {
  /** Record a message that has exhausted its retry budget. */
  add(key: MessageKey, pending: PendingMessage, attempts: number, lastError: string): void;
  /** Return all dead-lettered entries. */
  list(): DeadLetterEntry[];
  /** Move all entries back to the retry queue (returns them for re-processing). */
  drain(): DeadLetterEntry[];
  /** Remove a single entry by key (operator confirmed safe to discard). */
  discard(key: MessageKey): boolean;
  /** True if the given key is already dead-lettered. */
  has(key: MessageKey): boolean;
}

/** In-memory dead-letter store (survives the retry cycle; lost on restart). */
export class InMemoryDeadLetterStore implements DeadLetterStore {
  private readonly entries = new Map<string, DeadLetterEntry>();

  add(
    key: MessageKey,
    pending: PendingMessage,
    attempts: number,
    lastError: string,
  ): void {
    this.entries.set(messageKeyString(key), {
      key,
      pending,
      attempts,
      lastError,
      deadLetteredAt: Date.now(),
    });
  }

  list(): DeadLetterEntry[] {
    return [...this.entries.values()];
  }

  drain(): DeadLetterEntry[] {
    const all = this.list();
    this.entries.clear();
    return all;
  }

  discard(key: MessageKey): boolean {
    return this.entries.delete(messageKeyString(key));
  }

  has(key: MessageKey): boolean {
    return this.entries.has(messageKeyString(key));
  }
}
