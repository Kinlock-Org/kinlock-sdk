import type { FastifyInstance } from "fastify";

/** GET /health: includes indexer lag. Roadmap M2-12, M2-15. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_req, reply) => reply.code(501).send({ error: "not_implemented" }));
}
