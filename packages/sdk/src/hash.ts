/**
 * ref_hash = SHA-256(UTF-8(normalized reference) ‖ salt bytes). Roadmap M2-03.
 *
 * - The salt is 16 random bytes, carried in links as unpadded base64url (22 characters).
 *   Its fixed length makes the concatenation unambiguous.
 * - The reference is trimmed and Unicode-normalized (NFC), so the same reference typed on two
 *   devices hashes the same.
 *
 * Reference and salt exist only in the claim-link fragment and in memory: never log them.
 */
import { KinlockError } from "./errors.js";
import type { Hash32 } from "./types.js";

export const SALT_BYTES = 16;
const SALT_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_REFERENCE_LENGTH = 200;

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromBase64Url = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function normalizeReference(reference: string): string {
  const normalized = reference.normalize("NFC").trim();
  if (normalized.length === 0 || normalized.length > MAX_REFERENCE_LENGTH) {
    throw new KinlockError(
      `a reference must be 1 to ${MAX_REFERENCE_LENGTH} characters`,
      "INVALID_REFERENCE",
    );
  }
  return normalized;
}

export function isValidSalt(salt: string): boolean {
  return SALT_PATTERN.test(salt);
}

/** 16 random bytes from the platform's cryptographic RNG, as base64url. */
export function generateSalt(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/** The 32-byte ref_hash, as lowercase hex, matching the contract's `ref_hash`. */
export async function computeRefHash(reference: string, salt: string): Promise<Hash32> {
  if (!isValidSalt(salt)) {
    throw new KinlockError("the salt must be 16 bytes of base64url", "INVALID_LINK");
  }
  const referenceBytes = new TextEncoder().encode(normalizeReference(reference));
  const saltBytes = fromBase64Url(salt);
  const input = new Uint8Array(referenceBytes.length + saltBytes.length);
  input.set(referenceBytes, 0);
  input.set(saltBytes, referenceBytes.length);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return toHex(new Uint8Array(digest));
}
