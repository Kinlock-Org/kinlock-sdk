/** Event, handler and field types shared by the handlers. Roadmap M2-10. */
import type { Db } from "../db/client.js";

export const EVENT_TYPES = [
  "PayeeRegistered",
  "PayeeStatusChanged",
  "PayoutUpdated",
  "LockCreated",
  "Released",
  "Refunded",
  "Declined",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type Native =
  | string
  | number
  | bigint
  | boolean
  | null
  | Native[]
  | { [key: string]: Native };

export interface DecodedEvent {
  type: EventType;
  schemaVersion: number;
  txHash: string;
  /** Position of the event within its transaction (the second part of the RPC event id). */
  eventIndex: number;
  /** RPC event id (`<TOID>-<index>`), unique and ordered. */
  id: string;
  ledger: number;
  ledgerTime: Date;
  /** The topic after the event name: payee_id (hex) or lock id (bigint). */
  key: Native;
  payload: Record<string, Native>;
}

export interface TrancheSchedule {
  amount: bigint;
  /** Unix seconds. */
  unlockAt: bigint;
}

export interface HandlerContext {
  /** Tranche schedules read from chain (`get_lock`) for the batch's LockCreated events. */
  tranches: Map<bigint, TrancheSchedule[]>;
}

export type EventHandler = (db: Db, event: DecodedEvent, ctx: HandlerContext) => Promise<void>;

/** The data in the database disagrees with the event stream; ingestion must stop. */
export class InconsistentStateError extends Error {
  override name = "InconsistentStateError";
}

export class UnsupportedEventError extends Error {
  override name = "UnsupportedEventError";
}

/** Field accessors that fail loudly instead of writing a wrong row. */
export function str(event: DecodedEvent, field: string): string {
  const v = event.payload[field];
  if (typeof v !== "string")
    throw new InconsistentStateError(`${event.id}: ${field} is not a string`);
  return v;
}

export function int(event: DecodedEvent, field: string): bigint {
  const v = event.payload[field];
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  throw new InconsistentStateError(`${event.id}: ${field} is not an integer`);
}

/** Contract enums arrive as a one-element vec of the variant name, e.g. ["School"]. */
export function variant(event: DecodedEvent, field: string): string {
  const v = event.payload[field];
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === "string") return v[0];
  throw new InconsistentStateError(`${event.id}: ${field} is not an enum variant`);
}

export function payeeKey(event: DecodedEvent): string {
  if (typeof event.key !== "string") throw new InconsistentStateError(`${event.id}: bad payee_id`);
  return event.key;
}

export function lockKey(event: DecodedEvent): bigint {
  if (typeof event.key !== "bigint") throw new InconsistentStateError(`${event.id}: bad lock id`);
  return event.key;
}

export const fromUnix = (seconds: bigint): Date => new Date(Number(seconds) * 1000);
