# kinlock-sdk

[![CI](https://github.com/Kinlock-Org/kinlock-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Kinlock-Org/kinlock-sdk/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Kinlock-Org/kinlock-sdk)](https://github.com/Kinlock-Org/kinlock-sdk/releases)

TypeScript SDK (`packages/sdk`) and the event indexer + list API (`services/indexer`).

> **Status: active development, testnet only.** The client (`createLock`, `release`, `refund`, `decline`, `getLock`, `getPayee`), preflight, and receipt verification are implemented and released (v0.3.0); the indexer is still being scaffolded. See `ROADMAP.md`.

**Try it live (testnet):** [kinlock-app.vercel.app](https://kinlock-app.vercel.app) · **Docs:** [kinlock-org.github.io](https://kinlock-org.github.io)

## Quick start
```
docker compose up -d       # local Postgres
pnpm install
pnpm typecheck && pnpm build
```

## Read first
- `docs/ARCHITECTURE_ESSENTIALS.md` (short; read at the start of every task)
- `AGENTS.md` (rules for humans and agents) and `CLAUDE.md`
- `ROADMAP.md`: **every PR updates it**
- [`packages/sdk/API.md`](packages/sdk/API.md): every public export, with params, return types, and usage examples

Docs in `docs/` are read-only copies synced from [Kinlock-Org/.github](https://github.com/Kinlock-Org/.github).
