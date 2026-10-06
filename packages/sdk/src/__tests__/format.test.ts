import { describe, expect, it } from "vitest";
import { fromBaseUnits, toBaseUnits } from "../format.js";

describe("toBaseUnits", () => {
  it.each([
    ["0", 0n],
    ["1", 10_000_000n],
    ["12.5", 125_000_000n],
    ["0.0000001", 1n],
    ["17014118346046923173168730371588.4105727", 2n ** 127n - 1n],
  ])("%s", (input, expected) => {
    expect(toBaseUnits(input)).toBe(expected);
  });

  it.each(["", "-1", ".5", "1.", "01", "1e5", " 1", "1,000", "0.00000001", "abc"])(
    "rejects %j",
    (input) => {
      expect(() => toBaseUnits(input)).toThrow(expect.objectContaining({ code: "INVALID_AMOUNT" }));
    },
  );

  it("never rounds: 8 decimals is an error, not a rounded amount", () => {
    expect(() => toBaseUnits("1.00000001")).toThrow(/never rounded/);
  });

  it("respects other decimal counts", () => {
    expect(toBaseUnits("1.5", 2)).toBe(150n);
    expect(() => toBaseUnits("1.555", 2)).toThrow();
  });
});

describe("fromBaseUnits", () => {
  it.each([
    [0n, "0"],
    [1n, "0.0000001"],
    [10_000_000n, "1"],
    [125_000_000n, "12.5"],
    [-125_000_000n, "-12.5"],
  ])("%s", (input, expected) => {
    expect(fromBaseUnits(input)).toBe(expected);
  });

  it("round-trips", () => {
    for (const n of [0n, 1n, 9_999_999n, 10_000_001n, 123_456_789_012_345n, 2n ** 127n - 1n]) {
      expect(toBaseUnits(fromBaseUnits(n))).toBe(n);
    }
  });
});
