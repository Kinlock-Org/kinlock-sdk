/**
 * One handler per event type, dispatched on (event type, schema_version). Roadmap M2-10.
 * Must accept every schema_version the contract has ever emitted; anything else stops ingestion.
 */
import { declinedV1 } from "./declined.js";
import { lockCreatedV1 } from "./lock-created.js";
import { payeeRegisteredV1 } from "./payee-registered.js";
import { payeeStatusChangedV1 } from "./payee-status-changed.js";
import { payoutUpdatedV1 } from "./payout-updated.js";
import { refundedV1 } from "./refunded.js";
import { releasedV1 } from "./released.js";
import {
  type DecodedEvent,
  type EventHandler,
  type EventType,
  UnsupportedEventError,
} from "./types.js";

const HANDLERS: Record<EventType, Record<number, EventHandler>> = {
  PayeeRegistered: { 1: payeeRegisteredV1 },
  PayeeStatusChanged: { 1: payeeStatusChangedV1 },
  PayoutUpdated: { 1: payoutUpdatedV1 },
  LockCreated: { 1: lockCreatedV1 },
  Released: { 1: releasedV1 },
  Refunded: { 1: refundedV1 },
  Declined: { 1: declinedV1 },
};

export function handlerFor(event: DecodedEvent): EventHandler {
  const handler = HANDLERS[event.type][event.schemaVersion];
  if (!handler) {
    throw new UnsupportedEventError(
      `no handler for ${event.type} schema_version ${event.schemaVersion} (event ${event.id})`,
    );
  }
  return handler;
}
