import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeRefHash, generateSalt } from "../hash.js";
import { buildClaimLink, parseClaimLink } from "../links.js";

// Hard rule 5 (AGENTS.md §3): nothing derived from the claim-link fragment may reach a log.
// Roadmap M2-07. Any console output at all during these operations fails the test.
const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;

describe("claim-link data never reaches a log", () => {
  let spies: ReturnType<typeof vi.spyOn>[] = [];
  beforeEach(() => {
    spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });

  it("build, parse, and hash log nothing, including on errors", async () => {
    const salt = generateSalt();
    const link = buildClaimLink("https://kinlock.app", {
      lockId: 3n,
      reference: "SECRET-REF",
      salt,
    });
    const parts = parseClaimLink(link);
    await computeRefHash(parts.reference, parts.salt);
    expect(() => parseClaimLink("https://kinlock.app/claim/3#r=SECRET-REF&s=bad")).toThrow();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("error messages don't echo the reference or salt", () => {
    const salt = generateSalt();
    try {
      parseClaimLink(`https://kinlock.app/claim/0#r=SECRET-REF&s=${salt}`);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("SECRET-REF");
      expect(String((e as Error).message)).not.toContain(salt);
    }
  });
});
