import { describe, expect, it } from "vitest";
import * as sdk from "../index.js";

const isClass = (v: unknown) =>
  typeof v === "function" && /^class\b/.test(Function.prototype.toString.call(v));

describe("public API", () => {
  // AGENTS.md §8.2: adding public API needs approval, so the export list is pinned here.
  // ADR-0025 approved the amount, hashing, and request-link helpers on 2026-10-06;
  // ADR-0030 approved getPayee on 2026-10-07.
  it("exports exactly the approved functions (16)", () => {
    const functions = Object.entries(sdk)
      .filter(([, v]) => typeof v === "function" && !isClass(v))
      .map(([k]) => k)
      .sort();
    expect(functions).toEqual(
      [
        "buildClaimLink",
        "buildRequestLink",
        "computeRefHash",
        "createLock",
        "decline",
        "fromBaseUnits",
        "generateSalt",
        "getLock",
        "getPayee",
        "parseClaimLink",
        "parseRequestLink",
        "preflight",
        "refund",
        "release",
        "toBaseUnits",
        "verifyReceipt",
      ].sort(),
    );
  });

  // Stored contract enums are append-only; these must list variants in the contract's order.
  it("mirrors the contract's enums in order", () => {
    expect(sdk.CATEGORIES).toEqual(["School", "Rent"]);
    expect(sdk.PAYEE_STATUSES).toEqual(["Active", "Suspended", "Revoked"]);
    expect(sdk.LOCK_STATES).toEqual(["Open", "Completed", "Refunded", "Declined"]);
    expect(sdk.REFUND_REASONS).toEqual(["Expired", "Revoked", "SuspendedTimeout"]);
  });
});
