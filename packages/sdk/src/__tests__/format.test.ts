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

describe("amount precision and boundary characterisation (M2-21)", () => {
  const I128_MAX = 2n ** 127n - 1n; // 170141183460469231731687303715884105727n (39 digits)
  const ONE_ABOVE_I128_MAX = 2n ** 127n; // 170141183460469231731687303715884105728n (39 digits)
  const DIGITS_39 = 10n ** 39n - 1n; // 999999999999999999999999999999999999999n (39 digits)
  const DIGITS_40 = 10n ** 39n; // 1000000000000000000000000000000000000000n (40 digits)
  const I128_MAX_DIV_1E7 = I128_MAX / 10_000_000n; // 17014118346046923173168730371588n

  it("handles i128::MAX boundary: exactly 2^127 - 1 base units", () => {
    const decimal = "17014118346046923173168730371588.4105727";
    expect(toBaseUnits(decimal)).toBe(I128_MAX);
    expect(fromBaseUnits(I128_MAX)).toBe(decimal);
    expect(toBaseUnits(fromBaseUnits(I128_MAX))).toBe(I128_MAX);
  });

  it("characterises one above i128::MAX (2^127): accepted by SDK BigInt, rejected by contract i128 overflow", () => {
    const decimal = "17014118346046923173168730371588.4105728";
    expect(toBaseUnits(decimal)).toBe(ONE_ABOVE_I128_MAX);
    expect(fromBaseUnits(ONE_ABOVE_I128_MAX)).toBe(decimal);
    expect(toBaseUnits(fromBaseUnits(ONE_ABOVE_I128_MAX))).toBe(ONE_ABOVE_I128_MAX);
  });

  it("characterises 39-digit value (NUMERIC(39,0) maximum): accepted by SDK and Postgres column", () => {
    const decimal = "99999999999999999999999999999999.9999999";
    expect(toBaseUnits(decimal)).toBe(DIGITS_39);
    expect(fromBaseUnits(DIGITS_39)).toBe(decimal);
    expect(toBaseUnits(fromBaseUnits(DIGITS_39))).toBe(DIGITS_39);
  });

  it("characterises 40-digit value: accepted by SDK BigInt, rejected by Postgres NUMERIC(39,0)", () => {
    const decimal = "100000000000000000000000000000000";
    expect(toBaseUnits(decimal)).toBe(DIGITS_40);
    expect(fromBaseUnits(DIGITS_40)).toBe(decimal);
    expect(toBaseUnits(fromBaseUnits(DIGITS_40))).toBe(DIGITS_40);
  });

  it("characterises i128::MAX / 10^7 as largest plain integer amount for USDC", () => {
    // 17014118346046923173168730371588 * 10^7 <= i128::MAX
    const atLimit = toBaseUnits(I128_MAX_DIV_1E7.toString());
    expect(atLimit).toBe(170141183460469231731687303715880000000n);
    expect(atLimit <= I128_MAX).toBe(true);

    // One above: 17014118346046923173168730371589 * 10^7 > i128::MAX
    const aboveLimit = toBaseUnits((I128_MAX_DIV_1E7 + 1n).toString());
    expect(aboveLimit).toBe(170141183460469231731687303715890000000n);
    expect(aboveLimit > I128_MAX).toBe(true);
  });

  it("rejects negative human amounts in toBaseUnits while fromBaseUnits formats negative delta", () => {
    expect(() => toBaseUnits("-1")).toThrow(expect.objectContaining({ code: "INVALID_AMOUNT" }));
    expect(() => toBaseUnits("-0.1")).toThrow(expect.objectContaining({ code: "INVALID_AMOUNT" }));
    expect(fromBaseUnits(-100n)).toBe("-0.00001");
  });

  it("never rounds fractions longer than asset decimals", () => {
    expect(() => toBaseUnits("0.00000001")).toThrow(/never rounded/);
    expect(() => toBaseUnits("17014118346046923173168730371588.41057271")).toThrow(/never rounded/);
  });
});
