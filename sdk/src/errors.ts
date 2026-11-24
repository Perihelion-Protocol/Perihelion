// SPDX-License-Identifier: MIT

/**
 * Typed error hierarchy for the Perihelion SDK.
 *
 * Integrators should catch these types to distinguish error categories
 * programmatically rather than string-matching error messages.
 *
 * @example
 * ```ts
 * import { PerihelionHttpError, PerihelionTimeoutError } from "@perihelion/sdk";
 *
 * try {
 *   await client.submitIntent(signed);
 * } catch (e) {
 *   if (e instanceof PerihelionHttpError && e.status === 400) {
 *     // validation rejection — don't retry, surface to user
 *   } else if (e instanceof PerihelionHttpError && e.status >= 500) {
 *     // server error — retry
 *   }
 * }
 * ```
 */

/** Base class for all Perihelion SDK errors. */
export class PerihelionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/** Thrown when an HTTP request to the mempool returns a non-2xx status. */
export class PerihelionHttpError extends PerihelionError {
  readonly status: number;
  readonly body: string;
  readonly operation: string;
  constructor(operation: string, status: number, body: string, options?: ErrorOptions) {
    super(`[Perihelion] ${operation} failed: HTTP ${status} — ${body}`, options);
    this.operation = operation;
    this.status = status;
    this.body = body;
  }
}

/**
 * Thrown when a request or `waitForSettlement` exceeds its configured timeout.
 * For `waitForSettlement`, `lastStatus` holds the most recent observed status.
 */
export class PerihelionTimeoutError extends PerihelionError {
  readonly intentHash?: string;
  readonly lastStatus?: string;
  constructor(message: string, intentHash?: string, lastStatus?: string, options?: ErrorOptions) {
    super(message, options);
    this.intentHash = intentHash;
    this.lastStatus = lastStatus;
  }
}

/** Thrown when a network or transport failure occurs communicating with the mempool. */
export class PerihelionNetworkError extends PerihelionError {
  readonly operation?: string;
  constructor(message: string, operation?: string, options?: ErrorOptions) {
    super(message, options);
    this.operation = operation;
  }
}

/** Thrown when intent fields fail client-side validation before submission. */
export class PerihelionValidationError extends PerihelionError {
  readonly field?: string;
  constructor(message: string, field?: string, options?: ErrorOptions) {
    super(message, options);
    this.field = field;
  }
}

/**
 * Thrown when an intent fails field-level validation in `validateIntent` or
 * `buildIntent`. Extends {@link PerihelionValidationError} so callers can
 * catch either the specific type or the broader validation superclass.
 *
 * `field` names the first intent field that failed; `message` describes the
 * constraint that was violated.
 *
 * @example
 * ```ts
 * try {
 *   validateIntent(params);
 * } catch (e) {
 *   if (e instanceof IntentValidationError) {
 *     console.error(`Intent field '${e.field}' is invalid: ${e.message}`);
 *   }
 * }
 * ```
 */
export class IntentValidationError extends PerihelionValidationError {
  constructor(field: string, message: string, options?: ErrorOptions) {
    super(message, field, options);
  }
}

/**
 * Thrown by `listPending` when it stops before the server reports the last
 * page, so the caller never mistakes a partial order book for the whole one.
 *
 * - `reason: "max_pages"` — `maxPages` pages were fetched and the server still
 *   returned a `nextCursor`. More records exist; resume from `nextCursor` with
 *   `listPendingPage`, or raise `maxPages`.
 * - `reason: "repeated_cursor"` — the server returned a cursor it had already
 *   returned, so following it would loop forever. This is a server bug.
 *
 * `records` holds everything fetched before stopping, so a caller that can work
 * with a partial set can still use it.
 *
 * @example
 * ```ts
 * let pending: IntentRecord[];
 * try {
 *   pending = await client.listPending();
 * } catch (e) {
 *   if (!(e instanceof PerihelionPaginationError)) throw e;
 *   log.warn("order book truncated", { reason: e.reason, pages: e.pages });
 *   pending = e.records;
 * }
 * ```
 */
export class PerihelionPaginationError<T = unknown> extends PerihelionError {
  readonly reason: "max_pages" | "repeated_cursor";
  readonly records: T[];
  readonly nextCursor: string;
  readonly pages: number;
  constructor(
    reason: "max_pages" | "repeated_cursor",
    records: T[],
    nextCursor: string,
    pages: number,
    options?: ErrorOptions,
  ) {
    super(
      reason === "max_pages"
        ? `[Perihelion] listPending stopped after ${pages} pages (maxPages) with more records remaining; ` +
            `${records.length} records fetched, resume from cursor ${JSON.stringify(nextCursor)}`
        : `[Perihelion] listPending: server repeated cursor ${JSON.stringify(nextCursor)} after ${pages} pages; ` +
            `${records.length} records fetched`,
      options,
    );
    this.reason = reason;
    this.records = records;
    this.nextCursor = nextCursor;
    this.pages = pages;
  }
}

/**
 * Thrown when the mempool returns a hash that does not match the locally-computed
 * hash. This indicates a server bug or tampering attempt.
 */
export class PerihelionHashMismatchError extends PerihelionError {
  readonly localHash: string;
  readonly serverHash: string;
  constructor(localHash: string, serverHash: string, options?: ErrorOptions) {
    super(
      `[Perihelion] Server returned hash ${serverHash} but locally-computed hash is ${localHash}. ` +
        `This may indicate a server bug or tampering. The local hash is authoritative.`,
      options,
    );
    this.localHash = localHash;
    this.serverHash = serverHash;
  }
}

/**
 * Thrown by `getEscrowAddress` when no escrow is registered in `DEPLOYMENTS`
 * for the requested chain. `chainId` is the chain that was looked up.
 */
export class PerihelionUndeployedChainError extends PerihelionError {
  readonly chainId: number;
  constructor(chainId: number, options?: ErrorOptions) {
    super(
      `Chain ${chainId} is not deployed. See docs/deployment.md for deployment procedure and supported chains.`,
      options,
    );
    this.chainId = chainId;
  }
}

/**
 * Thrown when a contract call reverts with a custom error decoded from the
 * escrow ABI. `errorName` is the Solidity error identifier (e.g.
 * `"NoPendingOwner"`), `selector` is the 4-byte selector as a hex string, and
 * `args` holds any decoded error arguments.
 *
 * @example
 * ```ts
 * try {
 *   await escrow.write.cancelOwnershipTransfer();
 * } catch (e) {
 *   if (e instanceof PerihelionContractError && e.errorName === "NoPendingOwner") {
 *     // nothing to cancel — no pending transfer exists
 *   }
 * }
 * ```
 */
export class PerihelionContractError extends PerihelionError {
  readonly errorName: string;
  readonly selector?: string;
  readonly args?: readonly unknown[];
  constructor(
    errorName: string,
    selector?: string,
    args?: readonly unknown[],
    options?: ErrorOptions,
  ) {
    super(
      `[Perihelion] Contract reverted with ${errorName}` +
        (selector ? ` (selector ${selector})` : ""),
      options,
    );
    this.errorName = errorName;
    this.selector = selector;
    this.args = args;
  }
}

/**
 * Thrown when `cancelOwnershipTransfer` is called but no ownership transfer is
 * pending. The caller is the owner; the failure is that there is nothing to
 * cancel, not that the caller lacks ownership.
 */
export class NoPendingOwnerError extends PerihelionContractError {
  constructor(selector?: string, options?: ErrorOptions) {
    super("NoPendingOwner", selector, undefined, options);
  }
}

/**
 * Thrown when an asset is being allowlisted but the address has no contract
 * code. No transfer is attempted; the asset simply is not a contract.
 */
export class NotAContractError extends PerihelionContractError {
  constructor(selector?: string, options?: ErrorOptions) {
    super("NotAContract", selector, undefined, options);
  }
}

/**
 * Thrown when a call is made while the contract is paused. The contract
 * reverts with OpenZeppelin's `EnforcedPause()` error.
 */
export class EnforcedPauseError extends PerihelionContractError {
  constructor(selector?: string, options?: ErrorOptions) {
    super("EnforcedPause", selector, undefined, options);
  }
}

/**
 * Thrown when `lock` is called before the escrow's Stellar peer has been
 * configured. The escrow is not yet wired for cross-chain settlement; the
 * owner must call `setPeer` before any intent can be locked.
 */
export class PeerNotSetError extends PerihelionContractError {
  constructor(selector?: string, options?: ErrorOptions) {
    super(
      "PeerNotSet",
      selector,
      undefined,
      options,
    );
    this.message =
      `[Perihelion] Contract reverted with PeerNotSet` +
      (selector ? ` (selector ${selector})` : "") +
      `: the escrow's Stellar peer is not configured yet; the escrow owner must call setPeer before locking intents.`;
  }
}

/** Known custom error names emitted by the escrow contract. */
export type EscrowErrorName =
  | "NoPendingOwner"
  | "NotAContract"
  | "EnforcedPause"
  | "NotOwner"
  | "TransferFailed"
  | "NotAllowed"
  | "InvalidAmount"
  | "InvalidDeadline"
  | "AlreadySettled"
  | "IntentExpired"
  | "Unauthorized"
  | "PeerNotSet"
  | "ReentrancyGuardReentrantCall";

/**
 * Map a decoded contract error name to the matching typed SDK error. Unknown
 * names fall back to a generic {@link PerihelionContractError}.
 */
export function contractErrorFromName(
  errorName: string,
  selector?: string,
  args?: readonly unknown[],
  options?: ErrorOptions,
): PerihelionContractError {
  switch (errorName) {
    case "NoPendingOwner":
      return new NoPendingOwnerError(selector, options);
    case "NotAContract":
      return new NotAContractError(selector, options);
    case "EnforcedPause":
      return new EnforcedPauseError(selector, options);
    case "PeerNotSet":
      return new PeerNotSetError(selector, options);
    default:
      return new PerihelionContractError(errorName, selector, args, options);
  }
}
