/**
 * Polls getEvents from the persisted cursor, writes idempotently on (tx_hash, event_index),
 * and STOPS with an alert on any gap. Never skips a gap silently. Roadmap M2-09.
 *
 * One batch = one RPC page = one database transaction: the events, their effects and the cursor
 * commit together, so a crash at any point resumes from the last committed page. Replaying a
 * page writes nothing new, because handlers run only for events that weren't stored yet.
 */
import type { Db } from "../db/client.js";
import { chainEvents } from "../db/schema.js";
import { handlerFor } from "../handlers/index.js";
import type { DecodedEvent, TrancheSchedule } from "../handlers/types.js";
import { type EventsPage, ledgerOfCursor, type RpcClient } from "../rpc/client.js";
import type { LockReader } from "../rpc/locks.js";
import { readCursor, saveCursor } from "./cursor.js";
import { decodeEvent } from "./decode.js";

/** History the indexer needs is no longer available from RPC. Needs a human (backfill). */
export class GapError extends Error {
  override name = "GapError";
}

export interface IngestDeps {
  db: Db;
  rpc: RpcClient;
  locks: LockReader;
  contractId: string;
  /** Ledger to start from when no cursor exists (the contract's deploy ledger). */
  startLedger: number;
  pageSize?: number;
}

export interface BatchResult {
  received: number;
  stored: number;
  lastLedger: number;
  latestLedger: number;
}

/** Fetch and apply one page. Throws (and commits nothing) on a gap or an unhandled event. */
export async function ingestBatch(deps: IngestDeps): Promise<BatchResult> {
  const { db, rpc, contractId } = deps;
  const limit = deps.pageSize ?? 100;
  const cursor = await readCursor(db);

  let page: EventsPage;
  let resumeLedger: number;
  if (cursor?.lastEventId) {
    resumeLedger = Number(cursor.lastLedger);
    page = await rpc.getEvents({ contractId, cursor: cursor.lastEventId, limit });
  } else {
    resumeLedger = deps.startLedger;
    page = await rpc.getEvents({ contractId, startLedger: deps.startLedger, limit });
  }
  // A resume point older than the RPC's retained history means events may be missing.
  if (resumeLedger < page.oldestLedger) {
    throw new GapError(
      `resume ledger ${resumeLedger} is older than RPC history (oldest ${page.oldestLedger})`,
    );
  }

  const events = page.events.map(decodeEvent);
  for (const event of events) handlerFor(event); // unknown type/version: stop before writing

  const tranches = new Map<bigint, TrancheSchedule[]>();
  for (const event of events) {
    if (event.type === "LockCreated" && typeof event.key === "bigint") {
      tranches.set(event.key, await deps.locks.tranches(event.key));
    }
  }

  const lastLedger = ledgerOfCursor(page.cursor);
  let stored = 0;
  await db.transaction(async (tx) => {
    for (const event of events) {
      if (await storeEvent(tx, event)) {
        await handlerFor(event)(tx, event, { tranches });
        stored++;
      }
    }
    await saveCursor(tx, { lastLedger: BigInt(lastLedger), lastEventId: page.cursor });
  });
  return { received: events.length, stored, lastLedger, latestLedger: page.latestLedger };
}

/** Append to chain_events. False if this (tx_hash, event_index) was already stored. */
async function storeEvent(db: Db, event: DecodedEvent): Promise<boolean> {
  const inserted = await db
    .insert(chainEvents)
    .values({
      eventType: event.type,
      schemaVersion: event.schemaVersion,
      ledger: BigInt(event.ledger),
      ledgerTime: event.ledgerTime,
      txHash: event.txHash,
      eventIndex: event.eventIndex,
      payload: toJson(event),
    })
    .onConflictDoNothing({ target: [chainEvents.txHash, chainEvents.eventIndex] })
    .returning({ id: chainEvents.id });
  return inserted.length === 1;
}

/** The decoded event as JSON: bigints become decimal strings (never numbers). */
function toJson(event: DecodedEvent): unknown {
  return JSON.parse(
    JSON.stringify({ id: event.id, key: event.key, ...event.payload }, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
}

export interface PollerOptions extends IngestDeps {
  intervalMs: number;
  signal: AbortSignal;
  onBatch?: (result: BatchResult) => void;
}

/** Ingest until aborted. Pages back-to-back while behind; waits `intervalMs` once caught up. */
export async function runPoller(options: PollerOptions): Promise<void> {
  while (!options.signal.aborted) {
    const result = await ingestBatch(options);
    options.onBatch?.(result);
    if (result.received === 0 && result.lastLedger >= result.latestLedger - 1) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, options.intervalMs);
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
    }
  }
}
