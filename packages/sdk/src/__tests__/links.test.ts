import { describe, expect, it } from "vitest";
import { generateSalt } from "../hash.js";
import { buildClaimLink, buildRequestLink, parseClaimLink, parseRequestLink } from "../links.js";

const salt = "AAECAwQFBgcICQoLDA0ODw";

describe("claim links", () => {
  it("puts the reference and salt only in the fragment", () => {
    const link = buildClaimLink("https://kinlock.app", {
      lockId: 42n,
      reference: "Room 4B / Term 1",
      salt,
    });
    const url = new URL(link);
    expect(url.pathname).toBe("/claim/42");
    expect(url.search).toBe("");
    expect(url.hash).toContain("r=");
    // What a browser sends to the server: everything before '#'.
    const sentToServer = link.split("#")[0] ?? "";
    expect(sentToServer).not.toContain("Room");
    expect(sentToServer).not.toContain(salt);
  });

  it("round-trips, including characters that need encoding", () => {
    for (const reference of ["STU-1", "Room 4B & 5C", "学生#42", "a=b&c"]) {
      const salt2 = generateSalt();
      const parts = parseClaimLink(
        buildClaimLink("https://kinlock.app", { lockId: 7n, reference, salt: salt2 }),
      );
      expect(parts).toEqual({ lockId: 7n, reference, salt: salt2 });
    }
  });

  it.each([
    ["not a url", "nope"],
    ["wrong path", "https://kinlock.app/locks/1#r=a&s=AAECAwQFBgcICQoLDA0ODw"],
    ["lock id 0", "https://kinlock.app/claim/0#r=a&s=AAECAwQFBgcICQoLDA0ODw"],
    ["missing salt", "https://kinlock.app/claim/1#r=a"],
    ["bad salt", "https://kinlock.app/claim/1#r=a&s=xyz"],
    [
      "reference in the query, not the fragment",
      "https://kinlock.app/claim/1?r=a&s=AAECAwQFBgcICQoLDA0ODw",
    ],
  ])("rejects %s", (_why, link) => {
    expect(() => parseClaimLink(link)).toThrow(expect.objectContaining({ code: "INVALID_LINK" }));
  });

  it("only allows https origins (http only for localhost)", () => {
    const parts = { lockId: 1n, reference: "x", salt };
    expect(() => buildClaimLink("http://kinlock.app", parts)).toThrow();
    expect(() => buildClaimLink("https://kinlock.app/path", parts)).toThrow();
    expect(buildClaimLink("http://localhost:3000", parts)).toMatch(
      /^http:\/\/localhost:3000\/claim\/1#/,
    );
  });
});

describe("request links", () => {
  const payeeId = "ab".repeat(32);

  it("round-trips a schedule and carries no authority beyond pre-filling", () => {
    const parts = {
      payeeId,
      reference: "INV-77",
      schedule: [
        { amount: "100", unlockAt: 1_800_000_000n },
        { amount: "50.5", unlockAt: 1_810_000_000n },
      ],
    };
    const link = buildRequestLink("https://kinlock.app", parts);
    expect(new URL(link).pathname).toBe("/send");
    expect(parseRequestLink(link)).toEqual(parts);
  });

  it("rejects malformed payee ids and schedules", () => {
    expect(() =>
      parseRequestLink("https://kinlock.app/send?payee=zz&ref=a&schedule=1@1"),
    ).toThrow();
    expect(() =>
      parseRequestLink(`https://kinlock.app/send?payee=${payeeId}&ref=a&schedule=1.123456789@1`),
    ).toThrow();
  });
});
