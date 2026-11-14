/**
 * CLI and programmatic helper to replay Soroban contract events from a deployment
 * or custom start ledger into PostgreSQL without duplicating rows. Roadmap H-20, M2-16.
 */
import { pathToFileURL } from "node:url";
import { pino } from "pino";
import { loadConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { indexerCursor } from "../db/schema.js";
import { type BatchResult, ingestBatch } from "../ingest/poller.js";
import { syncRegistry } from "../registry/sync.js";
import { createRpcClient, type RpcClient } from "../rpc/client.js";
import { createLockReader, type LockReader } from "../rpc/locks.js";

export interface BackfillCliArgs {
  startLedger?: number;
  batchSize?: number;
}

export interface BackfillOptions {
  db: Db;
  rpc: RpcClient;
  locks: LockReader;
  contractId: string;
  startLedger: number;
  batchSize?: number;
  onBatch?: (batch: BatchResult) => void;
}

export interface BackfillSummary {
  batches: number;
  received: number;
  stored: number;
  lastLedger: number;
  latestLedger: number;
}

function parsePositiveInt(flag: string, raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error(`${flag} requires a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

/** Parse `--start-ledger` and `--batch-size` CLI flags. */
export function parseBackfillArgs(argv: readonly string[]): BackfillCliArgs {
  const result: BackfillCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--start-ledger") {
      result.startLedger = parsePositiveInt("--start-ledger", argv[++i]);
    } else if (arg.startsWith("--start-ledger=")) {
      result.startLedger = parsePositiveInt("--start-ledger", arg.slice("--start-ledger=".length));
    } else if (arg === "--batch-size") {
      result.batchSize = parsePositiveInt("--batch-size", argv[++i]);
    } else if (arg.startsWith("--batch-size=")) {
      result.batchSize = parsePositiveInt("--batch-size", arg.slice("--batch-size=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

/**
 * Reset the persisted cursor and replay all events from `startLedger` to the chain tip
 * in pages of `batchSize`. Idempotent on `(tx_hash, event_index)`.
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillSummary> {
  const pageSize = options.batchSize ?? 100;
  if (!Number.isInteger(options.startLedger) || options.startLedger <= 0) {
    throw new Error("startLedger must be a positive integer");
  }
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error("batchSize must be a positive integer");
  }

  await options.db.delete(indexerCursor);

  let batches = 0;
  let received = 0;
  let stored = 0;
  let lastLedger = options.startLedger;
  let latestLedger = options.startLedger;

  for (;;) {
    const batch = await ingestBatch({
      db: options.db,
      rpc: options.rpc,
      locks: options.locks,
      contractId: options.contractId,
      startLedger: options.startLedger,
      pageSize,
    });
    batches++;
    received += batch.received;
    stored += batch.stored;
    lastLedger = batch.lastLedger;
    latestLedger = batch.latestLedger;
    options.onBatch?.(batch);

    if (batch.received < pageSize) {
      break;
    }
  }

  return { batches, received, stored, lastLedger, latestLedger };
}

async function main(): Promise<void> {
  const cliArgs = parseBackfillArgs(process.argv.slice(2));
  const config = loadConfig();
  const log = pino({ name: "kinlock-indexer-backfill" });
  const { db, close } = createDb(config.DATABASE_URL);

  try {
    const startLedger = cliArgs.startLedger ?? config.KINLOCK_START_LEDGER;
    const batchSize = cliArgs.batchSize ?? 100;
    const rpc = createRpcClient(config.STELLAR_RPC_URLS);
    const locks = createLockReader(
      config.STELLAR_RPC_URLS,
      config.STELLAR_NETWORK_PASSPHRASE,
      config.KINLOCK_CONTRACT_ID,
    );

    const summary = await runBackfill({
      db,
      rpc,
      locks,
      contractId: config.KINLOCK_CONTRACT_ID,
      startLedger,
      batchSize,
      onBatch: (batch) => log.info(batch, "backfill batch ingested"),
    });

    if (config.REGISTRY_DIR) {
      await syncRegistry(db, config.REGISTRY_DIR);
    }

    log.info(summary, "backfill complete");
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
