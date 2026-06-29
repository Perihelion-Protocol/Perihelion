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
export interface CheckpointStore {
  /** Load the last persisted cursor, or `undefined` if none exists yet. */
  load(): Promise<number | undefined>;
  /** Persist the cursor. Called after each tick that advances it. */
  save(block: number): Promise<void>;
}

/** A checkpoint store that never persists; cursor resets to the start block on restart. */
export class NoopCheckpointStore implements CheckpointStore {
  async load(): Promise<number | undefined> {
    return undefined;
  }
  async save(): Promise<void> {}
}
