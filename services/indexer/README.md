# Kinlock indexer

Contract events → Postgres → read-only list API (`/locks`, `/locks/:id`, `/payees`, `/health`).
**Lists and dashboards only:** money-moving pages read the chain, never this API.

Settings: see `../../.env.example`. Typed API contract: `src/api/schemas.ts`. Public HTTP API reference: [`docs/API.md`](docs/API.md).

## Run locally

```bash
docker compose up -d                  # from the repo root: local Postgres
cd services/indexer
set -a; . ../../.env; set +a          # your copy of .env.example
pnpm build && pnpm start              # applies migrations, then runs the poller and API
```

## Where payee rows come from

A `payees` row is normally written by a `PayeeRegistered` event. Testnet RPC keeps about eight days
of event history, so a database that starts inside that window cannot replay the registration events
of payees registered earlier, and `/payees` would list nobody. At startup the indexer therefore reads
`get_payee` from the contract for every payee in `REGISTRY_DIR` that has **no row yet** and inserts it
with the values the contract reports (roadmap `M2-28`). It never updates a row the events already
wrote, never invents a payee (one the contract doesn't have is reported as skipped), and never
backfills locks — locks still come only from events, and a history gap still stops ingestion and
alerts. The registry join (M2-13) then binds names, city, country and attester handle to a seeded row
by `meta_hash`, exactly as it does for an event-derived one, so a seeded row is no less honest than a
replayed one.

## Deploy to testnet (Railway)

Testnet only. One service built from `services/indexer/Dockerfile` (selected by `railway.json`
at the repo root) plus a Railway Postgres database.

1. Create a Railway project, add **Postgres**, then add a service from the GitHub repo
   `Kinlock-Org/kinlock-sdk` (branch `main`). Railway reads `railway.json`.
2. Set the service variables (no secrets in the repo):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway reference variable) |
   | `STELLAR_RPC_URLS` | `https://soroban-testnet.stellar.org` plus a second testnet provider, comma-separated |
   | `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` |
   | `KINLOCK_CONTRACT_ID` | `contract_id` from `kinlock-contracts/deployments/testnet.json` |
   | `KINLOCK_START_LEDGER` | a ledger at or before the contract's first event (current testnet contract: `5052300`) |
   | `REGISTRY_GIT_URL` | `https://github.com/Kinlock-Org/kinlock-registry` |
   | `REGISTRY_SUBDIR` | `fixtures` (testnet payees) |
   | `RAILWAY_DOCKERFILE_PATH` | `services/indexer/Dockerfile` (needed: `railway up` ignored `railway.json` and fell back to Railpack) |

   Railway provides `PORT`. Generate a public domain for the service to reach the API.
3. Deploy. The container clones the registry, applies migrations, then starts. Check
   `GET /health` returns `"status":"ok"` and `GET /payees` lists the testnet payees with names.
4. **Backups:** `railway postgres pitr enable --service Postgres` turns on point-in-time
   recovery (continuous backups to a Railway bucket), and `railway postgres pitr schedule set
   --daily --service Postgres` adds a daily backup. On the current plan, PITR enabled; the daily
   schedule and on-demand backups were refused ("You do not have access to this resource").
5. **Restore test (once, before calling M2-18 done).** `railway postgres pitr restore --service
   Postgres --at <time> --new-service-name <name> --yes` restores into a **new** service and
   leaves the live database alone. Then either point a copy of the indexer at it, or:
   1. Record `select count(*) from chain_events` and `select last_ledger from indexer_cursor`.
   2. Restore the latest backup onto the volume, then restart the indexer service.
   3. Confirm the cursor went back to the backup's value, the indexer catches up (`/health` ok),
      and `chain_events` reaches at least the recorded count with no gap error in the logs.

**Restarts and stops.** The process exits non-zero on a gap, an unknown event version, or
inconsistent state (`fatal` log "indexer stopped"); Railway restarts it up to 10 times. A
repeating "indexer stopped" needs a human: see the error before anything else. Registry
changes apply on the next restart.

## Current testnet deployment

- Railway project `kinlock-indexer-testnet`, services `indexer` and `Postgres` (PITR enabled).
- API: https://indexer-production-705a.up.railway.app (`/health`, `/locks`, `/payees`).
- Deployed 2026-10-07 from `main` at the sdk#11 merge, contract
  `CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI`, registry `fixtures/`.
