// SPDX-License-Identifier: MIT

import type { Hex, Intent, SignedIntent, MempoolIntentStatus } from "@perihelion/sdk";

export type IntentStatus = MempoolIntentStatus;

export interface MempoolIntentRecord extends SignedIntent {
  status: IntentStatus;
  /** Unix timestamp in seconds when the record was created. */
  createdAt: number;
}
