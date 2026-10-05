/**
 * Pre-flight checks shared by the app and third parties. Roadmap M2-05. [sec]
 */
import { NotImplementedError } from "./errors.js";
import type { Address, Hash32 } from "./types.js";

/** Payout changes within this window trigger a warning to the sender. */
export const RECENT_PAYOUT_CHANGE_WINDOW_SECS = 7n * 24n * 60n * 60n;

export type PreflightCheck =
  | "sender_balance"
  | "payee_active"
  | "recent_payout_change"
  | "duplicate_ref_hash"
  | "payout_trustline_authorized";

export interface PreflightResult {
  check: PreflightCheck;
  ok: boolean;
  /** Message key for the app to translate; no user-facing text here. */
  messageKey: string;
}

export interface PreflightParams {
  sender: Address;
  token: Address;
  payeeId: Hash32;
  total: bigint;
  refHash: Hash32;
}

export async function preflight(_params: PreflightParams): Promise<PreflightResult[]> {
  throw new NotImplementedError("preflight", "M2-05");
}
