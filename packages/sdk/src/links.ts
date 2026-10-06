/**
 * Claim links: `{origin}/claim/{lockId}#r={reference}&s={salt}`.
 * The reference and salt live ONLY in the URL fragment, which browsers never send to a server.
 * Request links: `{origin}/send?payee=…&amount=…&ref=…&schedule=…`; they carry no authority.
 * Single source of the link formats. Roadmap M2-03. [sec]
 *
 * Never log, store server-side, or send anywhere a claim link or anything parsed from one.
 */
import { KinlockError } from "./errors.js";
import { toBaseUnits } from "./format.js";
import { isValidSalt, normalizeReference } from "./hash.js";
import type { Hash32 } from "./types.js";

export interface ClaimLinkParts {
  lockId: bigint;
  reference: string;
  salt: string;
}

const invalid = (why: string) => new KinlockError(`invalid link: ${why}`, "INVALID_LINK");

function checkOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw invalid("origin is not a URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw invalid("origin must be https (http is allowed only for localhost)");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw invalid("origin must not have a path, query, or fragment");
  }
  return url.origin;
}

export function buildClaimLink(origin: string, parts: ClaimLinkParts): string {
  if (parts.lockId < 1n) throw invalid("lock id must be positive");
  if (!isValidSalt(parts.salt)) throw invalid("salt must be 16 bytes of base64url");
  const fragment = new URLSearchParams({ r: normalizeReference(parts.reference), s: parts.salt });
  return `${checkOrigin(origin)}/claim/${parts.lockId}#${fragment}`;
}

export function parseClaimLink(link: string): ClaimLinkParts {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw invalid("not a URL");
  }
  const id = /^\/claim\/([1-9]\d*)$/.exec(url.pathname)?.[1];
  if (!id) throw invalid("path must be /claim/{lockId}");
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const reference = fragment.get("r");
  const salt = fragment.get("s");
  if (reference === null || salt === null) throw invalid("missing reference or salt");
  if (!isValidSalt(salt)) throw invalid("salt must be 16 bytes of base64url");
  return { lockId: BigInt(id), reference: normalizeReference(reference), salt };
}

// ----- Request links (not part of the public API yet: see roadmap F-19) -----

export interface RequestTranche {
  /** Decimal string in token units, e.g. "150.25". */
  amount: string;
  /** Unix seconds. */
  unlockAt: bigint;
}

export interface RequestLinkParts {
  payeeId: Hash32;
  reference: string;
  /** One or more tranches; their amounts sum to the requested total. */
  schedule: RequestTranche[];
}

const HASH32 = /^[0-9a-f]{64}$/;

/** schedule is encoded as `amount@unixSeconds` pairs joined by commas. */
export function buildRequestLink(origin: string, parts: RequestLinkParts): string {
  if (!HASH32.test(parts.payeeId)) throw invalid("payee id must be 32 bytes of hex");
  if (parts.schedule.length === 0) throw invalid("schedule needs at least one tranche");
  const schedule = parts.schedule
    .map((t) => {
      toBaseUnits(t.amount);
      return `${t.amount}@${t.unlockAt}`;
    })
    .join(",");
  const query = new URLSearchParams({
    payee: parts.payeeId,
    ref: normalizeReference(parts.reference),
    schedule,
  });
  return `${checkOrigin(origin)}/send?${query}`;
}

export function parseRequestLink(link: string): RequestLinkParts {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw invalid("not a URL");
  }
  if (url.pathname !== "/send") throw invalid("path must be /send");
  const payeeId = url.searchParams.get("payee") ?? "";
  const reference = url.searchParams.get("ref") ?? "";
  const scheduleText = url.searchParams.get("schedule") ?? "";
  if (!HASH32.test(payeeId)) throw invalid("payee id must be 32 bytes of hex");
  const schedule = scheduleText.split(",").map((pair) => {
    const m = /^([0-9.]+)@([0-9]+)$/.exec(pair);
    if (!m?.[1] || !m[2]) throw invalid("schedule entries must be amount@unixSeconds");
    toBaseUnits(m[1]);
    return { amount: m[1], unlockAt: BigInt(m[2]) };
  });
  return { payeeId, reference: normalizeReference(reference), schedule };
}
