import type { Hex } from "@perihelion/sdk";
import type { IntentStatus, MempoolIntentRecord } from "./types.js";

export class IntentStore {
  private records = new Map<Hex, MempoolIntentRecord>();

  set(hash: Hex, record: MempoolIntentRecord): void {
    this.records.set(hash, record);
  }

  get(hash: Hex): MempoolIntentRecord | undefined {
    return this.records.get(hash);
  }

  getByStatus(status: IntentStatus): MempoolIntentRecord[] {
    return Array.from(this.records.values()).filter((r) => r.status === status);
  }

  updateStatus(hash: Hex, status: IntentStatus): boolean {
    const record = this.records.get(hash);
    if (!record) return false;
    record.status = status;
    return true;
  }

  all(): MempoolIntentRecord[] {
    return Array.from(this.records.values());
  }
}
