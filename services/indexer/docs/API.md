# Kinlock Indexer List API Reference

> **Roadmap reference:** `M2-20` (Public HTTP reference for the list API).  
> **Base URL (testnet):** `https://indexer-production-705a.up.railway.app`  
> **Source contract:** `kinlock` on Soroban (Stellar testnet)  
> **Related specifications:** `AGENTS.md` §3.3, §8.2; `docs/ARCHITECTURE.md` §3; `services/indexer/src/api/schemas.ts`

---

## 1. Architectural Role and Invariants

The Kinlock Indexer polls Soroban contract events from the Stellar blockchain, decodes them, applies them idempotently to a PostgreSQL relational database, and exposes this read-only HTTP interface.

### Non-Negotiable Invariants (`AGENTS.md` §3)

1. **Chain is Truth (Hard Rule 3):**  
   This API is strictly for **lists, tables, and dashboards**. Any page or user flow that moves money—such as claiming a lock, releasing a tranche, refunding an expired lock, or declining a lock—**must read state directly from the Stellar blockchain** via the SDK (`getLock`, `getPayee`, etc.).
2. **Indexer State vs. Chain State:**  
   Every payload returned by the indexer (except `/health`) includes an `IndexerMeta` envelope identifying the record source and freshness:
   ```json
   {
     "source": "indexer",
     "indexedLedger": 5120300
   }
   ```
   All endpoints serve **eventually consistent indexer state**. A response reflects only what has been ingested and committed up to `indexedLedger`.
3. **404 Not Found Semantics:**  
   If `GET /locks/:id` or `GET /events/:txHash/:eventIndex` returns `404 Not Found`, it strictly means **"record not found in this indexer's database"**. It **does not mean** the lock or event does not exist on-chain. The indexer may be lagging, restarting, or catching up after a gap.
4. **Amount Precision (Zero Floating-Point):**  
   Money is never represented as floating-point numbers. Every money amount is serialized as a **base-10 integer string** in base units (stroops). For USDC (7 decimal places, `scale = 7`):
   - `1.0000000` USDC = `"10000000"` base units
   - `0.1000000` USDC = `"1000000"` base units
   - `0.0000001` USDC (the minimal discrete unit) = `"1"` base unit
   - Amounts up to 39 decimal digits (`NUMERIC(39,0)`) are strictly preserved without truncation or rounding.
5. **Timestamps:**  
   Every timestamp field is serialized as an ISO 8601 UTC string with millisecond precision (e.g. `2026-10-17T12:00:00.000Z`). Clients displaying local time should apply their viewer's timezone offset accordingly.

---

## 2. Route Summary Table

| Method | Path | Purpose | State Source | Status Codes |
|---|---|---|---|---|
| GET | `/health` | Indexer lag and ledger synchronization status | Indexer cursor + RPC tip | 200, 503 |
| GET | `/locks` | Paginated list of locks (newest first) | Indexer state | 200, 400 |
| GET | `/locks/:id` | Detailed lock view with scheduled tranches | Indexer state | 200, 400, 404 |
| GET | `/payees` | Paginated list of verified registry payees | Indexer state + Registry | 200, 400 |
| GET | `/events/:txHash/:eventIndex` | Contract event receipt lookup aid | Indexer state | 200, 400, 404 |

---

## 3. Route Details

### 3.1 GET `/health`

#### Purpose
Exposes indexer synchronization health and replication lag against the Stellar network tip. Used by uptime monitors, Kubernetes/Railway health checks, and dashboard lag banners (`LagNotice`).

#### State Source
**Hybrid**: Reads the locally committed cursor ledger (`indexer_cursor.last_ledger`) from Postgres and queries the current chain tip from the configured Stellar RPC provider (`latestLedger()`).

#### Parameters
None.

#### Threshold Logic (`routes/health.ts:10-34`)
- Status is `"ok"` (`HTTP 200`) when `lagLedgers <= maxLagLedgers` (default threshold: `10` ledgers).
- Status is `"lagging"` (`HTTP 503`) when `lagLedgers > maxLagLedgers`.
- Status is `"unknown"` (`HTTP 503`) when the chain tip cannot be retrieved from RPC or the cursor is uninitialized.

#### Response Schema (`HealthResponse`)
| Field | Type | Nullable | Description |
|---|---|:---:|---|
| `status` | `"ok" \| "lagging" \| "unknown"` | No | Overall health classification |
| `indexedLedger` | `integer` | Yes | Highest ledger committed by indexer; `null` before first batch |
| `latestLedger` | `integer` | Yes | Latest ledger reported by Stellar RPC; `null` if RPC unreachable |
| `lagLedgers` | `integer` | Yes | Difference `max(0, latestLedger - indexedLedger)`; `null` if unknown |
| `lastBatchAt` | `string` (ISO 8601 UTC) | Yes | Timestamp when indexer last committed a batch to Postgres |

#### Example: Healthy (200 OK)
```http
GET /health HTTP/1.1
Host: indexer-production-705a.up.railway.app
```
```json
{
  "status": "ok",
  "indexedLedger": 5120300,
  "latestLedger": 5120303,
  "lagLedgers": 3,
  "lastBatchAt": "2026-10-17T12:30:15.000Z"
}
```

#### Example: Lagging (503 Service Unavailable)
```json
{
  "status": "lagging",
  "indexedLedger": 5120200,
  "latestLedger": 5120300,
  "lagLedgers": 100,
  "lastBatchAt": "2026-10-17T12:00:00.000Z"
}
```

---

### 3.2 GET `/locks`

#### Purpose
Lists escrow locks matching optional search and filter criteria. Returns locks ordered by lock ID descending (newest first). Supports cursor-based pagination.

#### State Source
**Indexer state** (`source: "indexer"`). Eventually consistent. Never rely on this endpoint to verify if a lock has been released or refunded before taking on-chain action.

#### Query Parameters (`LocksQuery`)
| Parameter | Type | Required | Constraints & Description |
|---|---|:---:|---|
| `sender` | `string` | No | Stellar G-address (Ed25519 public key) or C-address (Contract ID) |
| `payee_id` | `string` | No | 32-byte hex string (64 lowercase hex characters `^[0-9a-f]{64}$`) |
| `ref_hash` | `string` | No | 32-byte lowercase hex string; used with `payee_id` for duplicate preflight check |
| `state` | `string` | No | One of: `"Open"`, `"Completed"`, `"Refunded"`, `"Declined"` |
| `limit` | `integer` | No | Min: `1`, Max: `100`, Default: `50` |
| `before` | `string` | No | Return locks with `id < before` (cursor pagination). Use previous `next` value. |

#### Response Schema (`LocksResponse`)
| Field | Type | Nullable | Description |
|---|---|:---:|---|
| `source` | `"indexer"` | No | Constant identifier confirming indexer origin |
| `indexedLedger` | `integer` | Yes | Ledger sequence number this response is fresh up to |
| `locks` | `Lock[]` | No | Array of lock summary objects (newest first) |
| `next` | `string` | Yes | Lock ID cursor for fetching the next page; `null` on final page |

##### `Lock` Object Fields
| Field | Type | Nullable | Units / Scale | Description |
|---|---|:---:|:---:|---|
| `id` | `string` | No | `u64` decimal | Numerical lock identifier |
| `sender` | `string` | No | Stellar address | Address of funding sender |
| `payeeId` | `string` | No | 64-char hex | Verified payee identifier hash |
| `payout` | `string` | No | Stellar address | Payout address snapshot taken at creation (immutable) |
| `token` | `string` | No | Stellar address | Token SAC contract address |
| `total` | `string` | No | Base units (scale 7) | Total locked token amount (e.g. `"100000000"` = 10.0 USDC) |
| `released` | `string` | No | Base units (scale 7) | Sum of released tranches to payout |
| `returned` | `string` | No | Base units (scale 7) | Sum refunded or declined back to sender |
| `refHash` | `string` | No | 64-char hex | SHA-256 reference hash (`#r=...&s=...` digest) |
| `state` | `string` | No | Enum | `"Open" \| "Completed" \| "Refunded" \| "Declined"` |
| `endReason` | `string` | Yes | Enum | `"Expired" \| "Revoked" \| "SuspendedTimeout" \| "Declined"` |
| `expiresAt` | `string` | No | ISO 8601 UTC | Lock expiration date |
| `createdAt` | `string` | No | ISO 8601 UTC | On-chain creation block timestamp |
| `createdTx` | `string` | No | 64-char hex | Transaction hash of the `create_lock` invocation |

#### Example Request
```http
GET /locks?sender=GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH3&limit=2 HTTP/1.1
Host: indexer-production-705a.up.railway.app
```

#### Example Response (200 OK)
```json
{
  "source": "indexer",
  "indexedLedger": 5120300,
  "locks": [
    {
      "id": "2",
      "sender": "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH3",
      "payeeId": "a7815d079f7663968e7ce11c3765009a09c5daccb4a123a9102d3f7567d43866",
      "payout": "GAP5X6V64F53X3KFFM4S4A3U2CPOFYTRX4L6A2J3S6C57Q3W6B5U4Y5Q",
      "token": "CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI",
      "total": "1",
      "released": "0",
      "returned": "1",
      "refHash": "dee2634ab9acdbfff6fe5c0595fcda66c0897d1c6968c290745da4f384e3ee5e",
      "state": "Refunded",
      "endReason": "Expired",
      "expiresAt": "2026-10-18T10:00:00.000Z",
      "createdAt": "2026-10-17T10:00:00.000Z",
      "createdTx": "c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef01234"
    },
    {
      "id": "1",
      "sender": "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH3",
      "payeeId": "4485665bae55d2562f20ad82cec50c8aaa99ddf613b982509711a6b474ded0ba",
      "payout": "GAYO5N5L7CH5MQF255ZAR57N4OB6H6GZ6J33A7264O6M3D6GFF5K3L4O",
      "token": "CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI",
      "total": "100000000",
      "released": "50000000",
      "returned": "50000000",
      "refHash": "dee2634ab9acdbfff6fe5c0595fcda66c0897d1c6968c290745da4f384e3ee5e",
      "state": "Declined",
      "endReason": "Declined",
      "expiresAt": "2026-10-24T12:00:00.000Z",
      "createdAt": "2026-10-17T09:00:00.000Z",
      "createdTx": "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0"
    }
  ],
  "next": null
}
```
*(Note: Lock ID 2 illustrates the minimal valid USDC amount of `0.0000001` USDC represented as `"1"` base unit.)*

#### Error Response: 400 Bad Request
Returned when validation fails (e.g. invalid sender address format or out-of-range limit):
```json
{
  "error": "bad_request",
  "issues": [
    {
      "path": "sender",
      "message": "invalid address"
    }
  ]
}
```

---

### 3.3 GET `/locks/:id`

#### Purpose
Fetches full details for a single escrow lock, including all constituent disbursement tranches and their release statuses.

#### State Source
**Indexer state** (`source: "indexer"`). Eventually consistent.  
**Critical Note:** A `404 Not Found` response indicates that the lock is not present in the indexer database. It does **not** prove non-existence on-chain. Money-moving UI actions must read from the chain directly via the SDK.

#### Path Parameters (`LockParams`)
| Parameter | Type | Required | Constraints |
|---|---|:---:|---|
| `id` | `string` | Yes | Non-negative integer string up to `2^64 - 1` (`^(0\|[1-9]\d{0,19})$`) |

#### Response Schema (`LockResponse`)
| Field | Type | Nullable | Description |
|---|---|:---:|---|
| `source` | `"indexer"` | No | Constant identifier |
| `indexedLedger` | `integer` | Yes | Freshness ledger sequence |
| `lock` | `LockDetail` | No | Lock object extending `Lock` with `tranches` array |

##### `Tranche` Object Fields
| Field | Type | Nullable | Units / Scale | Description |
|---|---|:---:|:---:|---|
| `idx` | `integer` | No | 0-indexed | Sequence index of the tranche within the lock |
| `amount` | `string` | No | Base units (scale 7) | Tranche amount in base units |
| `unlockAt` | `string` | No | ISO 8601 UTC | Unlock timestamp before which release is prohibited |
| `released` | `boolean` | No | Boolean flag | `true` if tranche has been claimed and paid to payout |
| `releaseTx` | `string` | Yes | 64-char hex | Transaction hash of the release invocation, or `null` |

#### Example Request
```http
GET /locks/1 HTTP/1.1
Host: indexer-production-705a.up.railway.app
```

#### Example Response (200 OK)
```json
{
  "source": "indexer",
  "indexedLedger": 5120300,
  "lock": {
    "id": "1",
    "sender": "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH3",
    "payeeId": "4485665bae55d2562f20ad82cec50c8aaa99ddf613b982509711a6b474ded0ba",
    "payout": "GAYO5N5L7CH5MQF255ZAR57N4OB6H6GZ6J33A7264O6M3D6GFF5K3L4O",
    "token": "CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI",
    "total": "100000000",
    "released": "50000000",
    "returned": "50000000",
    "refHash": "dee2634ab9acdbfff6fe5c0595fcda66c0897d1c6968c290745da4f384e3ee5e",
    "state": "Declined",
    "endReason": "Declined",
    "expiresAt": "2026-10-24T12:00:00.000Z",
    "createdAt": "2026-10-17T09:00:00.000Z",
    "createdTx": "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0",
    "tranches": [
      {
        "idx": 0,
        "amount": "50000000",
        "unlockAt": "2026-10-17T09:00:00.000Z",
        "released": true,
        "releaseTx": "b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef01"
      },
      {
        "idx": 1,
        "amount": "50000000",
        "unlockAt": "2026-10-20T12:00:00.000Z",
        "released": false,
        "releaseTx": null
      }
    ]
  }
}
```

#### Error Response: 404 Not Found
```json
{
  "error": "not_found"
}
```

---

### 3.4 GET `/payees`

#### Purpose
Lists verified institutional payees (Schools, Landlords/Rent) registered on-chain and enriched with official git-registry metadata. Ordered by `payee_id` ascending. Supports cursor pagination.

#### State Source
**Indexer state + Hash-bound Git Registry** (`source: "indexer"`).  
Registry metadata fields (`slug`, `displayName`, `country`, `localCurrency`, `city`, `attesterHandle`) are populated only when the registry file's SHA-256 canonical hash matches the on-chain `metaHash`. Otherwise, these fields are returned as `null`.
A payee row is normally derived from `PayeeRegistered` / `PayeeStatusChanged` / `PayoutUpdated` events. Because RPC event history is limited, a row for a payee whose events are no longer retrievable is instead seeded at startup from the contract's current `get_payee` state (roadmap `M2-28`): the same fields, read from chain rather than replayed. Either way the row is a mirror of chain state that can lag, not an authority — the app re-reads the chain before any money move.

#### Query Parameters (`PayeesQuery`)
| Parameter | Type | Required | Constraints & Description |
|---|---|:---:|---|
| `payee_id` | `string` | No | 32-byte lowercase hex string (`^[0-9a-f]{64}$`) |
| `category` | `string` | No | Enum: `"School"` or `"Rent"` |
| `country` | `string` | No | ISO 3166-1 alpha-2 uppercase country code (`^[A-Z]{2}$`) |
| `q` | `string` | No | Case-insensitive substring search on `displayName` or `slug` (1–100 chars; `%` and `_` escaped as literals) |
| `limit` | `integer` | No | Min: `1`, Max: `100`, Default: `50` |
| `after` | `string` | No | Return payees sorting after this `payee_id` (cursor pagination) |

#### Response Schema (`PayeesResponse`)
| Field | Type | Nullable | Description |
|---|---|:---:|---|
| `source` | `"indexer"` | No | Constant identifier |
| `indexedLedger` | `integer` | Yes | Freshness ledger sequence |
| `payees` | `Payee[]` | No | Array of payee records ordered by `payeeId` |
| `next` | `string` | Yes | `payeeId` cursor for next page; `null` if no more pages |

##### `Payee` Object Fields
| Field | Type | Nullable | Description |
|---|---|:---:|---|
| `payeeId` | `string` | No | 32-byte hex on-chain payee ID |
| `slug` | `string` | Yes | URL-friendly unique identifier from registry |
| `displayName` | `string` | Yes | Human-readable verified entity name |
| `category` | `"School" \| "Rent"` | No | Approved category classification |
| `status` | `"Active" \| "Suspended" \| "Revoked"` | No | On-chain authorization status |
| `statusChangedAt` | `string` (ISO 8601 UTC) | No | When status was last updated |
| `payout` | `string` | No | Current on-chain payout address |
| `payoutUpdatedAt` | `string` (ISO 8601 UTC) | Yes | Timestamp of last payout update (used for 7-day preflight caution) |
| `attester` | `string` | No | Stellar public key of the vouching attester |
| `attesterHandle` | `string` | Yes | Registry identifier of the attester organization |
| `metaHash` | `string` | No | 32-byte hex hash binding on-chain record to registry file |
| `country` | `string` | Yes | ISO 3166-1 alpha-2 country code (e.g. `"KE"`, `"PH"`) |
| `localCurrency` | `string` | Yes | ISO 4217 local currency code (e.g. `"KES"`, `"PHP"`) |
| `city` | `string` | Yes | Physical operating municipality |
| `registeredAt` | `string` (ISO 8601 UTC) | No | Initial on-chain registration timestamp |

#### Example Request
```http
GET /payees?category=School&limit=1 HTTP/1.1
Host: indexer-production-705a.up.railway.app
```

#### Example Response (200 OK)
```json
{
  "source": "indexer",
  "indexedLedger": 5120300,
  "payees": [
    {
      "payeeId": "4485665bae55d2562f20ad82cec50c8aaa99ddf613b982509711a6b474ded0ba",
      "slug": "greenwood-academy-ke",
      "displayName": "Greenwood Academy Nairobi",
      "category": "School",
      "status": "Active",
      "statusChangedAt": "2026-10-15T08:00:00.000Z",
      "payout": "GAYO5N5L7CH5MQF255ZAR57N4OB6H6GZ6J33A7264O6M3D6GFF5K3L4O",
      "payoutUpdatedAt": null,
      "attester": "GBEXAMPLEATTESTERKEY2345678901234567890123456789012345678",
      "attesterHandle": "stride-labs",
      "metaHash": "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
      "country": "KE",
      "localCurrency": "KES",
      "city": "Nairobi",
      "registeredAt": "2026-10-15T08:00:00.000Z"
    }
  ],
  "next": "4485665bae55d2562f20ad82cec50c8aaa99ddf613b982509711a6b474ded0ba"
}
```

---

### 3.5 GET `/events/:txHash/:eventIndex`

#### Purpose
Receipt lookup aid: maps an emitted contract event transaction hash and event index back to its associated escrow lock, tranche, and decoded payload.  
**Lookup aid only:** Final receipt verification confirms event presence and parameters against the live Soroban RPC (`verifyReceipt`).

#### State Source
**Indexer state** (`source: "indexer"`). Append-only `chain_events` table in Postgres.

#### Path Parameters (`EventParams`)
| Parameter | Type | Required | Constraints |
|---|---|:---:|---|
| `txHash` | `string` | Yes | 32-byte lowercase hex string (`^[0-9a-f]{64}$`) |
| `eventIndex` | `integer` | Yes | 0-indexed event sequence in the transaction (`0` to `2^31 - 1`) |

#### Response Schema (`EventResponse`)
| Field | Type | Nullable | Description |
|---|---|:---:|---|
| `source` | `"indexer"` | No | Constant identifier |
| `indexedLedger` | `integer` | Yes | Freshness ledger sequence |
| `event` | `ChainEvent` | No | Stored and decoded event object |

##### `ChainEvent` Object Fields
| Field | Type | Nullable | Description |
|---|---|:---:|---|
| `type` | `string` | No | Event topic symbol (e.g. `"lock_created"`, `"tranche_released"`) |
| `schemaVersion` | `integer` | No | Contract event format version (e.g. `1`) |
| `ledger` | `integer` | No | Sequence number of the block containing the event |
| `ledgerTime` | `string` (ISO 8601 UTC) | No | Timestamp of the enclosing ledger |
| `txHash` | `string` | No | 32-byte hex transaction hash |
| `eventIndex` | `integer` | No | Event index within the transaction |
| `payload` | `object` | No | Key-value dictionary of event parameters; integers represented as decimal strings |

#### Example Request
```http
GET /events/a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0/0 HTTP/1.1
Host: indexer-production-705a.up.railway.app
```

#### Example Response (200 OK)
```json
{
  "source": "indexer",
  "indexedLedger": 5120300,
  "event": {
    "type": "lock_created",
    "schemaVersion": 1,
    "ledger": 5120250,
    "ledgerTime": "2026-10-17T09:00:00.000Z",
    "txHash": "a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0",
    "eventIndex": 0,
    "payload": {
      "key": "1",
      "sender": "GBBUI4N57S3TBUZTUKQPKWY5DERT2ZHQN4LLQZ747W7CD5HU3FGHWDH3",
      "payee_id": "4485665bae55d2562f20ad82cec50c8aaa99ddf613b982509711a6b474ded0ba",
      "payout": "GAYO5N5L7CH5MQF255ZAR57N4OB6H6GZ6J33A7264O6M3D6GFF5K3L4O",
      "token": "CCSHDQFRYFC3AHV5NE6ULQW6X2CMG5RPANBORDXJGSUD6UKECASJQBRI",
      "total": "100000000",
      "ref_hash": "dee2634ab9acdbfff6fe5c0595fcda66c0897d1c6968c290745da4f384e3ee5e",
      "tranches_count": "2",
      "expires_at": "1792843200"
    }
  }
}
```

#### Error Response: 404 Not Found
```json
{
  "error": "not_found"
}
```
