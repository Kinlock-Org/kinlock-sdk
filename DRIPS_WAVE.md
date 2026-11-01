# Kinlock SDK & Indexer — Drips Wave Application & Review Summary

> Program: [Stellar Wave on Drips Network](https://www.drips.network/wave/stellar) (backed by the Stellar Development Foundation)  
> Organization: [`Kinlock-Org`](https://github.com/Kinlock-Org)  
> Repository: `Kinlock-Org/kinlock-sdk` (TypeScript SDK `@kinlock/sdk` & Event Indexer `@kinlock/indexer`)

This document provides a single-page executive and technical summary for the Drips Wave review panel evaluating Kinlock for inclusion in the Stellar Wave Program.

---

## 1. Project Overview & Real-World Utility

The **Kinlock SDK and Indexer** form the integration layer connecting frontends, wallets, and institutional partners with the Soroban smart contract on Stellar.

- **Real-World Problem:** Institutional escrow and programmatic payment locks require bulletproof transaction construction, deterministic preflight validations, and sub-second list queries without compromising non-custodial or privacy principles.
- **Components & Stellar Architecture:**
  - **`packages/sdk` (`@kinlock/sdk` v0.3.0):**
    - High-level TypeScript client wrapping generated Soroban bindings (`@kinlock/contract`).
    - Full transaction lifecycles: `createLock`, `createDirectLock`, `release`, `refund`, `decline`, `getLock`, `verifyReceipt`.
    - Zero-PII reference hashing: `ref_hash = sha256(reference ‖ salt)`. URL fragment generation (`buildClaimLink`, `parseClaimLink`) guarantees that memo references never reach any server or log.
    - Robust preflight checks: balance verification, SAC trustline authorization, duplicate `ref_hash` checks, and payee status validation.
    - Zero floating-point arithmetic: amounts are strictly `bigint` in code and decimal strings at API boundaries.
  - **`services/indexer` (`@kinlock/indexer`):**
    - High-throughput Soroban event ingestion service polling `getEvents`.
    - Idempotent database persistence in PostgreSQL (`NUMERIC(39,0)` for precision) keyed by `(tx_hash, event_index)`.
    - Multi-version event schema handling (`schema_version`).
    - OpenAPI 3.1-documented Fastify HTTP list API (`GET /locks`, `GET /locks/:id`, `GET /payees`).
    - Non-custodial architectural invariant: action pages read directly from chain RPC; indexer is strictly used for dashboards and list views.

---

## 2. Live Deployed Artifacts & Verification

| Resource | Link / Reference |
|---|---|
| **Live Indexer API (Testnet)** | [indexer-production-705a.up.railway.app](https://indexer-production-705a.up.railway.app) (`GET /health`) |
| **Interactive API Documentation** | [indexer-production-705a.up.railway.app/docs](https://indexer-production-705a.up.railway.app/docs) |
| **Live Web App (Testnet)** | [kinlock-app.vercel.app](https://kinlock-app.vercel.app) |
| **Documentation Hub** | [kinlock-org.github.io](https://kinlock-org.github.io) |
| **Contract ID (Testnet)** | [`CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI`](https://stellar.expert/explorer/testnet/contract/CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI) |
| **Admin Address (2-of-3 Multisig)** | `GDFOEZ673H2FMB4UUD57BPR76PJJQJCK7U2LND25QW5377Y6VUGKCWPV` |
| **Allowlisted USDC SAC Address** | `CAQCFVLOBWSG3DRR6CE67D5Q46MVAJWJ2K7G4GB5T3D56D3N25T7P2N6` |
| **Product Video Demo** | [media/kinlock-brag.mp4](media/kinlock-brag.mp4) |
| **Official Release Tag** | [`v0.3.0`](https://github.com/Kinlock-Org/kinlock-sdk/releases/tag/v0.3.0) |

---

## 3. Reviewer Checklist & Repository Hygiene

- [x] **Hosted under Organization:** [`Kinlock-Org`](https://github.com/Kinlock-Org)
- [x] **Permissive License:** Apache-2.0 ([`LICENSE`](LICENSE))
- [x] **Branch Protection:** Enforced on `main` (requires peer PR approvals and passing status checks)
- [x] **Continuous Integration (CI):** Green GitHub Actions running Biome linter, TypeScript `tsc --noEmit`, Vitest test suite, and clean build
- [x] **Security Hardening:**
  - CodeQL SAST analysis across JavaScript/TypeScript and GitHub Actions
  - Semgrep vulnerability scanning
  - OpenSSF Scorecard CI reporting
  - Strict input validation via Zod at all network boundaries
  - Zero-PII architectural verification tests
- [x] **Testing Rigor:**
  - 16 test suites with 180 passing tests
  - In-process PostgreSQL testing via PGlite (zero external Docker/database dependencies required for local test runs)
  - Unit tests covering preflight validations, receipt proofs, link serialization/deserialization, privacy invariants, and indexer event re-org handling
- [x] **Roadmap & Progress Tracking:** Every PR tracked and enforced via [`ROADMAP.md`](ROADMAP.md)

---

## 4. Drips Wave Task Queue & Issue Board

Issues for external contributors follow a strict three-tier complexity mapping aligned with Drips Wave points:
- **Trivial (100 points):** Minor schema validations, mock data enhancements, and documentation updates.
- **Medium (150 points):** Indexer gap-detection alerting, RPC exponential backoff refinements, and SDK preflight additions.
- **High (200 points):** Multi-schema event deserialization handlers, event archive cold-storage ingestion, and SDK batch-query optimizations.

> **Task Safety Rule:** Core cryptographic hashing (`sha256(reference ‖ salt)`), fund authorization parameters, and database write idempotency invariants are guarded by maintainer review. Wave tasks focus on non-destructive indexing listeners, format utilities, and client conveniences.

- **Active Bounty Issues:** [Kinlock SDK Wave Issues](https://github.com/Kinlock-Org/kinlock-sdk/issues?q=is%3Aissue+is%3Aopen+label%3Adrips-wave%2Cwave)
- **Contribution Guide:** [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/wave-issue-format.md`](https://github.com/Kinlock-Org/.github/blob/main/docs/wave-issue-format.md)

---

## 5. Core Maintainers

| Name | Role | GitHub | Contact |
|---|---|---|---|
| Ayobami Yazar | Core Maintainer (Full-Stack & Integrations) | [@YazarAyobami](https://github.com/YazarAyobami) | [Email](mailto:Yazarayobami76@gmail.com) |
| Adenike Ajala | Core Maintainer (Smart Contracts & Protocol) | [@abrcrmb](https://github.com/abrcrmb) | [Email](mailto:adenikeajala2018@gmail.com) |
