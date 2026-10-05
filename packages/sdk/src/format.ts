/**
 * The ONLY place token amounts are converted between base units (bigint) and decimal strings.
 * USDC uses 7 decimals. Locale-aware display (Intl) belongs in the app, not here. Roadmap M2-04.
 */
import { NotImplementedError } from "./errors.js";

export const USDC_DECIMALS = 7;

export function toBaseUnits(_decimal: string, _decimals: number = USDC_DECIMALS): bigint {
  throw new NotImplementedError("toBaseUnits", "M2-04");
}

export function fromBaseUnits(_amount: bigint, _decimals: number = USDC_DECIMALS): string {
  throw new NotImplementedError("fromBaseUnits", "M2-04");
}
