/**
 * Receipt verification from chain data, never the database. Roadmap M2-06 (tiers 1-2), M2-16 (tier 3).
 * Receipt URL: `/r/{txHash}/{eventIndex}`. Wording: "Payment to verified payee".
 */
import { NotImplementedError } from "./errors.js";

export type VerificationTier = "live_rpc" | "lock_state" | "archive";

export type ReceiptKind = "Released" | "Refunded" | "Declined";

export interface ReceiptRef {
  txHash: string;
  eventIndex: number;
}

export interface VerifyReceiptResult {
  valid: boolean;
  tier: VerificationTier | null;
  kind: ReceiptKind | null;
}

export async function verifyReceipt(_ref: ReceiptRef): Promise<VerifyReceiptResult> {
  throw new NotImplementedError("verifyReceipt", "M2-06");
}
