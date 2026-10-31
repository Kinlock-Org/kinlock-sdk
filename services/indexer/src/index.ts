/** Indexer process entry: load config, start poller and list API. Roadmap M2-08..M2-12. */

import { pino } from "pino";
import { buildServer } from "./api/server.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { runPoller } from "./ingest/poller.js";
import { bootstrapPayees } from "./registry/bootstrap.js";
import { syncRegistry } from "./registry/sync.js";
import { createRpcClient } from "./rpc/client.js";
import { createLockReader } from "./rpc/locks.js";
import { createPayeeReader } from "./rpc/payees.js";

const config = loadConfig();
const log = pino({ name: "kinlock-indexer" });
const { db, close } = createDb(config.DATABASE_URL);
const controller = new AbortController();

const rpc = createRpcClient(config.STELLAR_RPC_URLS);
const payeeReader = createPayeeReader(
  config.STELLAR_RPC_URLS,
  config.STELLAR_NETWORK_PASSPHRASE,
  config.KINLOCK_CONTRACT_ID,
);

// The chain tip for /health, fetched at most every 5 s however often /health is called.
let tip: { ledger: number; at: number } | undefined;
async function latestLedger(): Promise<number> {
  if (!tip || Date.now() - tip.at > 5_000) {
    tip = { ledger: await rpc.getLatestLedger(), at: Date.now() };
  }
  return tip.ledger;
}

// Registry join: at start, then periodically. Failures are logged, never fatal: the list API
// just shows on-chain fields until the next successful sync.
async function joinRegistry(): Promise<void> {
  if (!config.REGISTRY_DIR) return;
  try {
    const r = await syncRegistry(db, config.REGISTRY_DIR);
    if (r.unmatched.length || r.invalidFiles.length) log.warn(r, "registry join incomplete");
  } catch (err) {
    log.error({ err }, "registry join failed");
  }
}
if (!config.REGISTRY_DIR) log.warn("REGISTRY_DIR unset: payees will have no display data");

// Payees older than RPC history have no replayable event (M2-28): seed the missing rows from the
// contract before joining, so the first sync can bind display data to them. Logged, never fatal,
// like the join itself.
async function bootstrapPayeesFromChain(): Promise<void> {
  if (!config.REGISTRY_DIR) return;
  try {
    const r = await bootstrapPayees(db, config.REGISTRY_DIR, payeeReader);
    if (r.seeded.length) log.info(r, "payee rows seeded from chain");
    if (r.skipped.length) log.warn(r.skipped, "payees not seeded");
  } catch (err) {
    log.error({ err }, "payee bootstrap failed");
  }
}
await bootstrapPayeesFromChain();

await joinRegistry();
const registryTimer = setInterval(joinRegistry, config.REGISTRY_SYNC_MS);

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
    if (r.stored > 0) void joinRegistry(); // a new payee shows its name without waiting
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
  clearInterval(registryTimer);
  await app.close();
  await close();
}
