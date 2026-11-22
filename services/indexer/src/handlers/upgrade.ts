/**
 * UpgradeProposed / UpgradeApplied (ADR-0033). Admin events with no list-API state: they are kept
 * only as rows in the append-only `chain_events` table (written before any handler runs), so an
 * upgrade proposal is visible to anyone auditing the event stream.
 */
import type { EventHandler } from "./types.js";

export const upgradeProposedV1: EventHandler = async () => {};

export const upgradeAppliedV1: EventHandler = async () => {};
