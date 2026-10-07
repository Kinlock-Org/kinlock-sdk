import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { chainEvents } from "../../db/schema.js";
import { type ApiDeps, indexerMeta, parseOr400 } from "../http.js";
import { type ChainEvent, EventParams, type EventResponse } from "../schemas.js";

/**
 * GET /events/:txHash/:eventIndex  (receipt lookup: which lock and tranche an event refers to)
 * A LOOKUP AID ONLY: receipt verification confirms everything on chain (ARCHITECTURE.md §7.3).
 */
export function eventRoutes({ db }: ApiDeps) {
  return async (app: FastifyInstance): Promise<void> => {
    app.get("/events/:txHash/:eventIndex", async (req, reply) => {
      const p = parseOr400(EventParams, req.params, reply);
      if (!p) return;
      const [row] = await db
        .select()
        .from(chainEvents)
        .where(and(eq(chainEvents.txHash, p.txHash), eq(chainEvents.eventIndex, p.eventIndex)));
      if (!row) return reply.code(404).send({ error: "not_found" });
      const event: ChainEvent = {
        type: row.eventType,
        schemaVersion: row.schemaVersion,
        ledger: Number(row.ledger),
        ledgerTime: row.ledgerTime.toISOString(),
        txHash: row.txHash,
        eventIndex: row.eventIndex,
        payload: row.payload as Record<string, unknown>,
      };
      const body: EventResponse = { ...(await indexerMeta(db)), event };
      return body;
    });
  };
}
