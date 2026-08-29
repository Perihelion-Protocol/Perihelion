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
