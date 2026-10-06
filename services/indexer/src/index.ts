/** Indexer process entry: load config, start poller and list API. Roadmap M2-08..M2-12. */

import { pino } from "pino";
import { buildServer } from "./api/server.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { runPoller } from "./ingest/poller.js";
import { createRpcClient } from "./rpc/client.js";
import { createLockReader } from "./rpc/locks.js";

const config = loadConfig();
const log = pino({ name: "kinlock-indexer" });
const { db, close } = createDb(config.DATABASE_URL);
const controller = new AbortController();

const rpc = createRpcClient(config.STELLAR_RPC_URLS);

// The chain tip for /health, fetched at most every 5 s however often /health is called.
let tip: { ledger: number; at: number } | undefined;
async function latestLedger(): Promise<number> {
  if (!tip || Date.now() - tip.at > 5_000) {
    tip = { ledger: await rpc.getLatestLedger(), at: Date.now() };
  }
  return tip.ledger;
}

const app = buildServer({ db, latestLedger, maxLagLedgers: config.MAX_LAG_LEDGERS });
await app.listen({ port: config.PORT, host: "0.0.0.0" });

const poller = runPoller({
  db,
  rpc,
  locks: createLockReader(
    config.STELLAR_RPC_URLS,
    config.STELLAR_NETWORK_PASSPHRASE,
    config.KINLOCK_CONTRACT_ID,
  ),
  contractId: config.KINLOCK_CONTRACT_ID,
  startLedger: config.KINLOCK_START_LEDGER,
  intervalMs: config.POLL_INTERVAL_MS,
  signal: controller.signal,
  onBatch: (r) => {
    if (r.received > 0) log.info(r, "batch ingested");
  },
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => controller.abort());
}

try {
  await poller;
} catch (err) {
  // Gaps, unknown events and inconsistent state stop the indexer: a human must look (alert).
  log.fatal({ err }, "indexer stopped");
  process.exitCode = 1;
} finally {
  await app.close();
  await close();
}
