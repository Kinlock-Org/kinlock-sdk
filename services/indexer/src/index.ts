/** Indexer process entry: load config, start poller and list API. Roadmap M2-08..M2-12. */

import { buildServer } from "./api/server.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildServer();
await app.listen({ port: config.PORT, host: "0.0.0.0" });
