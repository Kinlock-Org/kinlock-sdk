import { and, asc, eq, gt, ilike, or, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { payees } from "../../db/schema.js";
import { type ApiDeps, indexerMeta, parseOr400 } from "../http.js";
import { type Payee, PayeesQuery, type PayeesResponse } from "../schemas.js";

type PayeeRow = typeof payees.$inferSelect;

const toPayee = (r: PayeeRow): Payee => ({
  payeeId: r.payeeId,
  slug: r.slug,
  displayName: r.displayName,
  category: r.category as Payee["category"],
  status: r.status as Payee["status"],
  statusChangedAt: r.statusChangedAt.toISOString(),
  payout: r.payout,
  payoutUpdatedAt: r.payoutUpdatedAt?.toISOString() ?? null,
  attester: r.attester,
  metaHash: r.metaHash,
  country: r.country,
  localCurrency: r.localCurrency,
  city: r.city,
  registeredAt: r.registeredAt.toISOString(),
});

/** `%` and `_` in user input are literals, not wildcards. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * GET /payees?category=&country=&q=&limit=&after=  (ordered by payee_id)
 * Registry fields (slug, name, country, city) are null until the registry join (M2-13, M2-19).
 * Roadmap M2-12.
 */
export function payeeRoutes({ db }: ApiDeps) {
  return async (app: FastifyInstance): Promise<void> => {
    app.get("/payees", async (req, reply) => {
      const q = parseOr400(PayeesQuery, req.query, reply);
      if (!q) return;
      const where: (SQL | undefined)[] = [];
      if (q.category) where.push(eq(payees.category, q.category));
      if (q.country) where.push(eq(payees.country, q.country));
      if (q.q) {
        const pattern = `%${escapeLike(q.q)}%`;
        where.push(or(ilike(payees.displayName, pattern), ilike(payees.slug, pattern)));
      }
      if (q.after) where.push(gt(payees.payeeId, q.after));
      const rows = await db
        .select()
        .from(payees)
        .where(and(...where))
        .orderBy(asc(payees.payeeId))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const body: PayeesResponse = {
        ...(await indexerMeta(db)),
        payees: page.map(toPayee),
        next: rows.length > q.limit ? (page.at(-1)?.payeeId ?? null) : null,
      };
      return body;
    });
  };
}
