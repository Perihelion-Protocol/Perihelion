// SPDX-License-Identifier: MIT

export class FatalError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "FatalError";
  }
}
