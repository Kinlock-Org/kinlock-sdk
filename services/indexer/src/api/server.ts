/**
 * Fastify list API. FOR LISTS AND DASHBOARDS ONLY: money-moving pages read the chain.
 * Roadmap M2-12.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";
import { lockRoutes } from "./routes/locks.js";
import { payeeRoutes } from "./routes/payees.js";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(healthRoutes);
  app.register(lockRoutes);
  app.register(payeeRoutes);
  return app;
}
