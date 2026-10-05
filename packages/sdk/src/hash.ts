/**
 * ref_hash = sha256(reference || salt). Roadmap M2-03.
 * Reference and salt exist only in the claim-link fragment and in memory: never log them.
 */
import { NotImplementedError } from "./errors.js";
import type { Hash32 } from "./types.js";

export function generateSalt(): string {
  throw new NotImplementedError("generateSalt", "M2-03");
}

export async function computeRefHash(_reference: string, _salt: string): Promise<Hash32> {
  throw new NotImplementedError("computeRefHash", "M2-03");
}
