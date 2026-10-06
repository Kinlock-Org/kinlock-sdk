import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeRefHash, generateSalt, isValidSalt, normalizeReference } from "../hash.js";

/** Independent reference implementation with Node's crypto, not the SDK's own code. */
const expected = (reference: string, salt: string) =>
  createHash("sha256")
    .update(Buffer.concat([Buffer.from(reference, "utf8"), Buffer.from(salt, "base64url")]))
    .digest("hex");

describe("generateSalt", () => {
  it("is 16 random bytes as base64url", () => {
    const salts = new Set(Array.from({ length: 200 }, generateSalt));
    expect(salts.size).toBe(200);
    for (const s of salts) {
      expect(isValidSalt(s)).toBe(true);
      expect(Buffer.from(s, "base64url").length).toBe(16);
    }
  });
});

describe("computeRefHash", () => {
  const salt = "AAECAwQFBgcICQoLDA0ODw"; // bytes 0..15

  it("matches an independent SHA-256 of reference bytes followed by salt bytes", async () => {
    expect(await computeRefHash("STU-2024-001", salt)).toBe(expected("STU-2024-001", salt));
  });

  it("is 32 bytes of lowercase hex", async () => {
    expect(await computeRefHash("x", salt)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("depends on the salt, so a guessable reference can't be looked up", async () => {
    expect(await computeRefHash("STU-1", salt)).not.toBe(
      await computeRefHash("STU-1", generateSalt()),
    );
  });

  it("normalizes: surrounding spaces and Unicode composition don't change the hash", async () => {
    const composed = "Ecolé"; // e + combining acute
    expect(await computeRefHash(`  ${composed} `, salt)).toBe(await computeRefHash("Ecolé", salt));
  });

  it("handles non-Latin references", async () => {
    expect(await computeRefHash("学生-42", salt)).toBe(expected("学生-42", salt));
  });

  it("rejects a malformed salt and an empty or overlong reference", async () => {
    await expect(computeRefHash("x", "short")).rejects.toMatchObject({ code: "INVALID_LINK" });
    await expect(computeRefHash("   ", salt)).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await expect(computeRefHash("x".repeat(201), salt)).rejects.toMatchObject({
      code: "INVALID_REFERENCE",
    });
  });

  it("normalizeReference keeps the reference otherwise unchanged", () => {
    expect(normalizeReference(" Room 4B ")).toBe("Room 4B");
  });
});
