/** Public API. Adding exports here is ask-first (AGENTS.md §8.2). */
export { createLock, release, refund, decline, getLock } from "./client.js";
export type { CreateLockParams } from "./client.js";
export { verifyReceipt } from "./receipts.js";
export type { ReceiptRef, VerifyReceiptResult } from "./receipts.js";
export { buildClaimLink, parseClaimLink } from "./links.js";
export type { ClaimLinkParts } from "./links.js";
export { preflight } from "./preflight.js";
export type { PreflightResult, PreflightParams } from "./preflight.js";
export * from "./types.js";
export { KinlockError, NotImplementedError } from "./errors.js";
