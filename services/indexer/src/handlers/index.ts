/**
 * One handler per event type, dispatched on (event type, schema_version). Roadmap M2-10.
 * Must accept every schema_version the contract has ever emitted.
 */
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

export interface DecodedEvent {
  type: EventType;
  schemaVersion: number;
  txHash: string;
  eventIndex: number;
  ledger: bigint;
  ledgerTime: Date;
  payload: Record<string, unknown>;
}

export type EventHandler = (event: DecodedEvent) => Promise<void>;
