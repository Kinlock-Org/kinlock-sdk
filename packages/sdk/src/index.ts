/** Public API. Adding exports here is ask-first (AGENTS.md §8.2). */

export type { CreateLockParams } from "./client.js";
export { createLock, decline, getLock, refund, release } from "./client.js";
export { KinlockError, NotImplementedError } from "./errors.js";
export type { ClaimLinkParts } from "./links.js";
export { buildClaimLink, parseClaimLink } from "./links.js";
export type { PreflightParams, PreflightResult } from "./preflight.js";
export { preflight } from "./preflight.js";
export type { ReceiptRef, VerifyReceiptResult } from "./receipts.js";
export { verifyReceipt } from "./receipts.js";
export * from "./types.js";
