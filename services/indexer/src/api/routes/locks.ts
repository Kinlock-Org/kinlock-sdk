import type { FastifyInstance } from "fastify";

/**
 * GET /locks?sender=&payee_id=&state=  (lists)
 * GET /locks/:id  (display convenience; the app re-reads chain before any action)
 * Roadmap M2-12.
 */
export async function lockRoutes(app: FastifyInstance): Promise<void> {
  app.get("/locks", async (_req, reply) => reply.code(501).send({ error: "not_implemented" }));
  app.get("/locks/:id", async (_req, reply) => reply.code(501).send({ error: "not_implemented" }));
}
