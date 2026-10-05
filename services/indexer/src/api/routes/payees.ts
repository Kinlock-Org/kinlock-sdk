import type { FastifyInstance } from "fastify";

/** GET /payees?category=&country=&q=  joined with registry data. Roadmap M2-12, M2-19. */
export async function payeeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/payees", async (_req, reply) => reply.code(501).send({ error: "not_implemented" }));
}
