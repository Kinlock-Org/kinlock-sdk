import type { FastifyInstance } from "fastify";
import { readCursorRow } from "../../ingest/cursor.js";
import type { ApiDeps } from "../http.js";
import type { HealthResponse } from "../schemas.js";

/**
 * GET /health: indexer lag against the chain tip. Roadmap M2-12 (lag alerting is M2-15).
 * 200 when within `maxLagLedgers`, 503 when lagging or when the chain tip can't be read.
 */
export function healthRoutes({ db, latestLedger, maxLagLedgers }: ApiDeps) {
  return async (app: FastifyInstance): Promise<void> => {
    app.get("/health", async (_req, reply) => {
      const cursor = await readCursorRow(db);
      const indexedLedger = cursor ? Number(cursor.lastLedger) : null;
      let tip: number | null = null;
      try {
        tip = await latestLedger();
      } catch {
        // Reported as status "unknown" below.
      }
      const lagLedgers =
        tip !== null && indexedLedger !== null ? Math.max(0, tip - indexedLedger) : null;
      const status: HealthResponse["status"] =
        lagLedgers === null ? "unknown" : lagLedgers > maxLagLedgers ? "lagging" : "ok";
      const body: HealthResponse = {
        status,
        indexedLedger,
        latestLedger: tip,
        lagLedgers,
        lastBatchAt: cursor?.updatedAt.toISOString() ?? null,
      };
      return reply.code(status === "ok" ? 200 : 503).send(body);
    });
  };
}
