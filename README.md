# kinlock-sdk

[![CI](https://github.com/Kinlock-Org/kinlock-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Kinlock-Org/kinlock-sdk/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Kinlock-Org/kinlock-sdk/badge)](https://scorecard.dev/viewer/?uri=github.com/Kinlock-Org/kinlock-sdk)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Kinlock-Org/kinlock-sdk)](https://github.com/Kinlock-Org/kinlock-sdk/releases)

The TypeScript client for the `kinlock` contract (`packages/sdk`) and the event indexer plus list API (`services/indexer`).

> **Status: SDK v0.3.0 released; indexer built and running on testnet.** Both halves work. What's left is multi-`schema_version` handler coverage (`M2-10`), the tier-3/archive verification path (`M2-16`, blocked on the archive decision `M0-09`), and lag alerting (`M2-15`). See `ROADMAP.md`.

**Try it live (testnet):** [kinlock-app.vercel.app](https://kinlock-app.vercel.app) · **Docs:** [kinlock-org.github.io](https://kinlock-org.github.io) · **Indexer:** [indexer-production-705a.up.railway.app](https://indexer-production-705a.up.railway.app) (`GET /health`)

## First 15 minutes

To get up and running from a fresh checkout:

1. **Prerequisites:** Node 20+, pnpm 10 (`corepack enable pnpm`).
2. **Install dependencies:**
   ```bash
   pnpm install
   ```
3. **Run tests:**
   ```bash
   pnpm test
   ```
   Vitest runs all 15 test files (9 in `@kinlock/sdk`, 6 in `@kinlock/indexer`) using in-process PGlite; no external database or local Postgres installation is required.  
   *Note: SDK and indexer tests run from the workspace root (packages do not define individual `test` scripts).*
4. **Build and check:**
   ```bash
   pnpm build
   pnpm typecheck
   pnpm lint
   ```
5. **Run the indexer locally (optional):**
   ```bash
   docker compose up -d                 # local Postgres 17
   pnpm --filter indexer db:migrate     # apply Drizzle migrations
   pnpm --filter indexer dev            # watch poller + list API
   ```

## Layout

| Package | Name | What it is |
|---|---|---|
| `packages/sdk` | `@kinlock/sdk` v0.3.0 | Typed client: writes, chain reads, preflight, claim/request links, receipt verification |
| `services/indexer` | `@kinlock/indexer` | Long-running poller: Soroban events → Postgres → Fastify list API |

Dependency flow: `kinlock-contracts` → generated bindings (`@kinlock/contract`) → `@kinlock/sdk` → `kinlock-app`.

## Using the SDK

```ts
import { createLock, getLock, preflight, buildClaimLink } from "@kinlock/sdk";
```

Sixteen public exports, all documented in [`packages/sdk/API.md`](packages/sdk/API.md):

- **Writes:** `createLock`, `release`, `refund`, `decline` — each builds, simulates, then hands the XDR to your signer, and submits. The SDK never holds a key.
- **Chain reads:** `getLock`, `getPayee`.
- **Links:** `buildClaimLink`, `parseClaimLink`, `buildRequestLink`, `parseRequestLink`.
- **Checks:** `preflight` (5 checks: 3 block, 2 warn; an `unknown` result is never treated as a pass), `verifyReceipt` (tier 1 live RPC, tier 2 lock state; tier 3 depends on the archive decision).
- **Primitives:** `toBaseUnits`, `fromBaseUnits`, `generateSalt`, `computeRefHash`, plus `USDC_DECIMALS`, `KinlockError`, `NotImplementedError` and the `Lock`/`Payee`/`Tranche` types.

Two invariants the SDK enforces, because everything downstream relies on them:

- **Money is `bigint` in code and a decimal string in JSON.** Never a `number`. USDC has 7 decimals and the only place formatting lives is `format.ts`.
- **The reference and its salt exist only in the URL fragment.** `buildClaimLink` puts them in `#r=…&s=…`, which browsers never send to a server. On-chain you see only `ref_hash` = SHA-256 of the NFC-trimmed reference bytes concatenated with 16 raw salt bytes (ADR-0024). Nothing derived from the fragment is logged or transmitted.

## Running the indexer

```
docker compose up -d                 # local Postgres 17
pnpm install
pnpm --filter indexer db:migrate
pnpm --filter indexer dev            # poller + list API
```

It polls `getEvents` from a persisted cursor, is idempotent on `(tx_hash, event_index)`, and treats missing RPC history as a **gap**: it stops with a `GapError` rather than skipping silently. `chain_events` is append-only.

Routes: `GET /health` (returns 503 when lagging), `/locks`, `/locks/:id`, `/payees`, `/events/:txHash/:eventIndex`. Full HTTP reference: [`services/indexer/docs/API.md`](services/indexer/docs/API.md).

**These reads are for lists and dashboards only.** Pages that move money — claim, release, refund, decline — read the chain directly. The indexer may lag without affecting correctness.

## Commands

```
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Vitest runs both projects (15 test files: 9 SDK test files, 6 indexer test files against in-process Postgres via PGlite; 165 tests total as of 2026-10). Node 20, TypeScript 7, Biome for lint and format. `publish.yml` attaches a `.tgz` to a GitHub Release on any `sdk-v*` tag — packages ship as release artifacts, not through npm (ADR-0026).

## Read first

- `docs/ARCHITECTURE_ESSENTIALS.md` (short; read at the start of every task)
- `AGENTS.md` (rules for humans and agents) and `CLAUDE.md`
- `ROADMAP.md`: **every PR updates it**
- [`packages/sdk/API.md`](packages/sdk/API.md): every public export, with params, return types, and examples
- [`services/indexer/README.md`](services/indexer/README.md): deployment, env vars, gap recovery

Docs in `docs/` are read-only copies synced from [Kinlock-Org/.github](https://github.com/Kinlock-Org/.github).

Found a documentation gap (missing, unclear, or outdated docs)? File it at [Kinlock-Org.github.io](https://github.com/Kinlock-Org/Kinlock-Org.github.io/issues/new/choose) with `area:sdk`, the org's documentation hub, not here.
