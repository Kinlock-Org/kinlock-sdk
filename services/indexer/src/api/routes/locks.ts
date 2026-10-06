import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { locks, tranches } from "../../db/schema.js";
import { type ApiDeps, indexerMeta, parseOr400 } from "../http.js";
import {
  type Lock,
  LockParams,
  type LockResponse,
  LocksQuery,
  type LocksResponse,
  type Tranche,
} from "../schemas.js";

type LockRow = typeof locks.$inferSelect;
type TrancheRow = typeof tranches.$inferSelect;

const toLock = (r: LockRow): Lock => ({
  id: r.id.toString(),
  sender: r.sender,
  payeeId: r.payeeId,
  payout: r.payout,
  token: r.token,
  total: r.total.toString(),
  released: r.released.toString(),
  returned: r.returned.toString(),
  refHash: r.refHash,
  state: r.state as Lock["state"],
  endReason: r.endReason,
  expiresAt: r.expiresAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
  createdTx: r.createdTx,
});

const toTranche = (t: TrancheRow): Tranche => ({
  idx: t.idx,
  amount: t.amount.toString(),
  unlockAt: t.unlockAt.toISOString(),
  released: t.released,
  releaseTx: t.releaseTx,
});

/**
 * GET /locks?sender=&payee_id=&state=&limit=&before=  (lists, newest first)
 * GET /locks/:id  (display convenience; the app re-reads chain before any action)
 * Roadmap M2-12.
 */
export function lockRoutes({ db }: ApiDeps) {
  return async (app: FastifyInstance): Promise<void> => {
    app.get("/locks", async (req, reply) => {
      const q = parseOr400(LocksQuery, req.query, reply);
      if (!q) return;
      const where: SQL[] = [];
      if (q.sender) where.push(eq(locks.sender, q.sender));
      if (q.payee_id) where.push(eq(locks.payeeId, q.payee_id));
      if (q.state) where.push(eq(locks.state, q.state));
      if (q.before !== undefined) where.push(lt(locks.id, q.before));
      const rows = await db
        .select()
        .from(locks)
        .where(and(...where))
        .orderBy(desc(locks.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const body: LocksResponse = {
        ...(await indexerMeta(db)),
        locks: page.map(toLock),
        next: rows.length > q.limit ? (page.at(-1)?.id.toString() ?? null) : null,
      };
      return body;
    });

    app.get("/locks/:id", async (req, reply) => {
      const p = parseOr400(LockParams, req.params, reply);
      if (!p) return;
      const [row] = await db.select().from(locks).where(eq(locks.id, p.id));
      if (!row) return reply.code(404).send({ error: "not_found" });
      const t = await db
        .select()
        .from(tranches)
        .where(eq(tranches.lockId, p.id))
        .orderBy(tranches.idx);
      const body: LockResponse = {
        ...(await indexerMeta(db)),
        lock: { ...toLock(row), tranches: t.map(toTranche) },
      };
      return body;
    });
  };
}
