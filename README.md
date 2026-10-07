# kinlock-sdk

TypeScript SDK (`packages/sdk`) and the event indexer + list API (`services/indexer`).

> **Status: active development, testnet only.** The client (`createLock`, `release`, `refund`, `decline`, `getLock`, `getPayee`), preflight, and receipt verification are implemented and released (v0.3.0); the indexer is still being scaffolded. See `ROADMAP.md`.

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

Docs in `docs/` are read-only copies synced from [Kinlock-Org/.github](https://github.com/Kinlock-Org/.github).
