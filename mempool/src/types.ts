import type { Hex, Intent, SignedIntent } from "@perihelion/sdk";

export type IntentStatus = "pending" | "settled" | "refunded" | "expired";

export interface MempoolIntentRecord {
  hash: Hex;
  intent: Intent;
  signature: Hex;
  status: IntentStatus;
  submittedAt: number;
}
