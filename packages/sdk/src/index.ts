/** Public API. Adding exports here is ask-first (AGENTS.md §8.2; additions in ADR-0025, ADR-0030). */

export type { CreateLockParams, KinlockConfig, Signer } from "./client.js";
export { createLock, decline, getLock, getPayee, refund, release } from "./client.js";
export type { KinlockErrorCode } from "./errors.js";
export { KinlockError, NotImplementedError } from "./errors.js";
export { fromBaseUnits, toBaseUnits, USDC_DECIMALS } from "./format.js";
export { computeRefHash, generateSalt } from "./hash.js";
export type { ClaimLinkParts, RequestLinkParts, RequestTranche } from "./links.js";
export { buildClaimLink, buildRequestLink, parseClaimLink, parseRequestLink } from "./links.js";
export type { PreflightParams, PreflightResult } from "./preflight.js";
export { preflight } from "./preflight.js";
export type {
  ReceiptKind,
  ReceiptRef,
  VerificationTier,
  VerifiedReceipt,
  VerifyReceiptReason,
  VerifyReceiptResult,
} from "./receipts.js";
export { verifyReceipt } from "./receipts.js";
export * from "./types.js";
