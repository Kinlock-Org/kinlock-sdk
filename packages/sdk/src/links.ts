/**
 * Claim links: `/claim/{id}#r={reference}&s={salt}`. The fragment never reaches a server.
 * Request links: `/send?payee=…&amount=…&ref=…&schedule=…`; they carry no authority.
 * Single source of the link formats. Roadmap M2-03. [sec]
 */
import { NotImplementedError } from "./errors.js";
import type { Hash32 } from "./types.js";

export interface ClaimLinkParts {
  lockId: bigint;
  reference: string;
  salt: string;
}

export function buildClaimLink(_origin: string, _parts: ClaimLinkParts): string {
  throw new NotImplementedError("buildClaimLink", "M2-03");
}

export function parseClaimLink(_url: string): ClaimLinkParts {
  throw new NotImplementedError("parseClaimLink", "M2-03");
}

export interface RequestLinkParts {
  payeeId: Hash32;
  /** Decimal string in token units. */
  amount: string;
  reference: string;
  /** Tranche schedule, encoding to be fixed in M2-03. */
  schedule: string;
}

export function buildRequestLink(_origin: string, _parts: RequestLinkParts): string {
  throw new NotImplementedError("buildRequestLink", "M2-03");
}

export function parseRequestLink(_url: string): RequestLinkParts {
  throw new NotImplementedError("parseRequestLink", "M2-03");
}
