// SPDX-License-Identifier: MIT

/**
 * Persists the relayer's cursor across restarts.
 *
 * The relayer is a long-running daemon that will crash and redeploy; without
 * a durable checkpoint it must either re-scan from genesis (wasteful, leans
 * entirely on `isDelivered` idempotency) or resume from "now" (silently
 * missing messages emitted while it was down). Implementations must persist
 * `save(block)` durably enough to survive a process crash — at minimum an
 * fsync'd file or a transactional DB write — since the value is the sole
 * record of relay progress.
 */
import type { NonceCounter } from "./evm-watcher.js";

export interface CheckpointStore {
  /** Load the last persisted cursor, or `undefined` if none exists yet. */
  load(): Promise<number | undefined>;
  /** Persist the cursor. Called after each tick that advances it. */
  save(block: number): Promise<void>;

  /**
   * Load the last emitted LayerZero nonce for a given path, or `undefined`
   * if none has been emitted yet. The path is identified by the source
   * endpoint id and the destination endpoint id.
   *
   * Used when the relayer impersonates the LayerZero endpoint during
   * development (issue #936): the nonce must be strictly increasing per
   * path and survive restarts, otherwise the settlement contract's replay
   * guard rejects deliveries as `StaleNonce`.
   */
  loadNonce(srcEid: number, dstEid: number): Promise<number | undefined>;
  /**
   * Persist the last emitted LayerZero nonce for a given path. Must be
   * durable enough to survive a process crash, since reusing a nonce after
   * a restart would be rejected as a replay by the settlement contract.
   */
  saveNonce(srcEid: number, dstEid: number, nonce: number): Promise<void>;
}

/** Stable string key identifying a LayerZero path (source eid : destination eid). */
export function nonceKey(srcEid: number, dstEid: number): string {
  return `${srcEid}:${dstEid}`;
}

/**
 * Build a persisted {@link NonceCounter} backed by a {@link CheckpointStore}.
 *
 * Each call reads the last persisted nonce, persists the next one *before*
 * returning it, and so never hands out a nonce that a restart could repeat.
 */
export function checkpointNonceCounter(
  store: CheckpointStore,
  srcEid: number,
  dstEid: number,
): NonceCounter {
  return {
    async next(): Promise<bigint> {
      const last = (await store.loadNonce(srcEid, dstEid)) ?? 0;
      const next = last + 1;
      await store.saveNonce(srcEid, dstEid, next);
      return BigInt(next);
    },
  };
}

/** A checkpoint store that never persists; cursor resets to the start block on restart. */
export class NoopCheckpointStore implements CheckpointStore {
  async load(): Promise<number | undefined> {
    return undefined;
  }
  async save(): Promise<void> {}

  async loadNonce(): Promise<number | undefined> {
    return undefined;
  }
  async saveNonce(): Promise<void> {}
}
