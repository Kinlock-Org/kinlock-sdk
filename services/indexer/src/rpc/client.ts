/**
 * Soroban RPC client (JSON-RPC over fetch) with multi-provider failover. Roadmap M2-08.
 *
 * - Every response is validated with Zod at the boundary.
 * - Network failures, timeouts, HTTP 429 and 5xx move on to the next provider; a JSON-RPC error
 *   (for example "start ledger out of range") is a real answer and is thrown, not retried.
 * - RPC history is limited: missing history is a gap, never "no events" (see ingest/poller.ts).
 */
import { z } from "zod";

export const RpcEventSchema = z.object({
  type: z.string(),
  ledger: z.number().int(),
  ledgerClosedAt: z.string(),
  contractId: z.string(),
  id: z.string(),
  txHash: z.string(),
  topicJson: z.array(z.unknown()),
  valueJson: z.unknown(),
});
export type RpcEvent = z.infer<typeof RpcEventSchema>;

const GetEventsResultSchema = z.object({
  events: z.array(RpcEventSchema),
  cursor: z.string(),
  latestLedger: z.number().int(),
  oldestLedger: z.number().int(),
});
export type EventsPage = z.infer<typeof GetEventsResultSchema>;

const LatestLedgerSchema = z.object({ sequence: z.number().int() });

const JsonRpcResponseSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

/** The RPC server answered with a JSON-RPC error. */
export class RpcError extends Error {
  override name = "RpcError";
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

/** No configured provider could be reached. */
export class RpcUnavailableError extends Error {
  override name = "RpcUnavailableError";
}

export type EventsQuery =
  | { contractId: string; startLedger: number; limit: number }
  | { contractId: string; cursor: string; limit: number };

export interface RpcClient {
  getLatestLedger(): Promise<number>;
  getEvents(query: EventsQuery): Promise<EventsPage>;
}

const TIMEOUT_MS = 15_000;

export function createRpcClient(urls: string[], fetchImpl: typeof fetch = fetch): RpcClient {
  if (urls.length === 0) throw new Error("at least one RPC URL is required");
  let current = 0;

  async function call(method: string, params?: unknown): Promise<unknown> {
    const failures: string[] = [];
    for (let attempt = 0; attempt < urls.length; attempt++) {
      const index = (current + attempt) % urls.length;
      const url = urls[index] as string;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        failures.push(`${url}: ${(e as Error).message}`);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        failures.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      const body = JsonRpcResponseSchema.parse(await response.json());
      current = index; // stick with the provider that answered
      if (body.error) throw new RpcError(body.error.message, body.error.code);
      return body.result;
    }
    throw new RpcUnavailableError(`all RPC providers failed: ${failures.join("; ")}`);
  }

  return {
    async getLatestLedger() {
      return LatestLedgerSchema.parse(await call("getLatestLedger")).sequence;
    },
    async getEvents(query) {
      const filters = [{ type: "contract", contractIds: [query.contractId] }];
      const params =
        "cursor" in query
          ? { filters, pagination: { cursor: query.cursor, limit: query.limit }, xdrFormat: "json" }
          : {
              startLedger: query.startLedger,
              filters,
              pagination: { limit: query.limit },
              xdrFormat: "json",
            };
      return GetEventsResultSchema.parse(await call("getEvents", params));
    },
  };
}

/** The ledger a paging cursor points at (cursors are `<TOID>-<index>`; TOID = ledger << 32 | …). */
export function ledgerOfCursor(cursor: string): number {
  const toid = BigInt(cursor.split("-")[0] ?? "0");
  return Number(toid >> 32n);
}
