/**
 * Fastify list API. FOR LISTS AND DASHBOARDS ONLY: money-moving pages read the chain.
 * Roadmap M2-12. Request and response types: ./schemas.ts.
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { ApiDeps } from "./http.js";
import { healthRoutes } from "./routes/health.js";
import { lockRoutes } from "./routes/locks.js";
import { payeeRoutes } from "./routes/payees.js";

export function buildServer(deps: ApiDeps, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? true });
  app.register(healthRoutes(deps));
  app.register(lockRoutes(deps));
  app.register(payeeRoutes(deps));
  return app;
}
