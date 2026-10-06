/**
 * The ONLY place token amounts are converted between base units (bigint) and decimal strings.
 * USDC uses 7 decimals. Locale-aware display (Intl) belongs in the app, not here. Roadmap M2-04.
 *
 * Conversions are exact: input with more decimal places than the token has is rejected, never
 * rounded, because a rounded amount is a different amount of money.
 */
import { KinlockError } from "./errors.js";

export const USDC_DECIMALS = 7;

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

/** "12.5" -> 125000000n for 7 decimals. Non-negative plain decimals only. */
export function toBaseUnits(decimal: string, decimals: number = USDC_DECIMALS): bigint {
  const match = DECIMAL.exec(decimal);
  if (!match) {
    throw new KinlockError(`not a plain non-negative decimal: "${decimal}"`, "INVALID_AMOUNT");
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new KinlockError(
      `"${decimal}" has more than ${decimals} decimal places; amounts are never rounded`,
      "INVALID_AMOUNT",
    );
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/** 125000000n -> "12.5" for 7 decimals. Trailing zeros are dropped; integers have no dot. */
export function fromBaseUnits(amount: bigint, decimals: number = USDC_DECIMALS): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
