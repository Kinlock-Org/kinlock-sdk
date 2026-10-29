import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import type { Db } from "../src/db/client.js";

export interface RouteEntry {
  method: string;
  path: string;
}

export function parseRouteTableFromMarkdown(content: string): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const lines = content.split(/\r?\n/);
  let inRouteTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("| Method | Path |")) {
      inRouteTable = true;
      continue;
    }
    if (inRouteTable) {
      if (!trimmed.startsWith("|")) {
        inRouteTable = false;
        continue;
      }
      if (trimmed.includes("---")) {
        continue;
      }
      const cells = trimmed
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length >= 2) {
        const method = cells[0].toUpperCase();
        const rawPath = cells[1].replace(/`/g, "");
        routes.push({ method, path: rawPath });
      }
    }
  }

  return routes;
}

export function sortRoutes(routes: RouteEntry[]): RouteEntry[] {
  return [...routes].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

export async function getRegisteredAppRoutes(): Promise<RouteEntry[]> {
  const routes: RouteEntry[] = [];
  const app = buildServer(
    {
      db: null as unknown as Db,
      latestLedger: async () => 0,
      maxLagLedgers: 10,
    },
    { logger: false },
  );

  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const m of methods) {
      if (m === "HEAD") continue;
      routes.push({ method: m.toUpperCase(), path: routeOptions.url });
    }
  });

  await app.ready();
  return routes;
}

describe("API documentation parity (Roadmap M2-20, Issue #35)", () => {
  const docPath = resolve(__dirname, "../docs/API.md");

  it("finds services/indexer/docs/API.md on disk", () => {
    expect(existsSync(docPath)).toBe(true);
  });

  it("parses the route table from docs/API.md and matches Fastify registered routes exactly", async () => {
    const docContent = readFileSync(docPath, "utf-8");
    const docRoutes = parseRouteTableFromMarkdown(docContent);
    const appRoutes = await getRegisteredAppRoutes();

    expect(docRoutes.length).toBeGreaterThan(0);
    expect(appRoutes.length).toBeGreaterThan(0);

    const sortedDoc = sortRoutes(docRoutes);
    const sortedApp = sortRoutes(appRoutes);

    expect(sortedDoc).toEqual(sortedApp);
  });

  it("detects route mismatches when a route is renamed or omitted", () => {
    const realRoutes: RouteEntry[] = [
      { method: "GET", path: "/health" },
      { method: "GET", path: "/events/:txHash/:eventIndex" },
      { method: "GET", path: "/locks" },
      { method: "GET", path: "/locks/:id" },
      { method: "GET", path: "/payees" },
    ];

    // Case 1: Route renamed (e.g. /health -> /healthz)
    const renamedRoutes: RouteEntry[] = [
      { method: "GET", path: "/healthz" },
      { method: "GET", path: "/events/:txHash/:eventIndex" },
      { method: "GET", path: "/locks" },
      { method: "GET", path: "/locks/:id" },
      { method: "GET", path: "/payees" },
    ];
    expect(sortRoutes(renamedRoutes)).not.toEqual(sortRoutes(realRoutes));

    // Case 2: Route missing from documentation
    const missingRoutes: RouteEntry[] = [
      { method: "GET", path: "/health" },
      { method: "GET", path: "/locks" },
      { method: "GET", path: "/payees" },
    ];
    expect(sortRoutes(missingRoutes)).not.toEqual(sortRoutes(realRoutes));
  });

  it("verifies all five expected endpoints are documented", () => {
    const docContent = readFileSync(docPath, "utf-8");
    const docRoutes = parseRouteTableFromMarkdown(docContent);
    const paths = docRoutes.map((r) => `${r.method} ${r.path}`);

    expect(paths).toContain("GET /health");
    expect(paths).toContain("GET /locks");
    expect(paths).toContain("GET /locks/:id");
    expect(paths).toContain("GET /payees");
    expect(paths).toContain("GET /events/:txHash/:eventIndex");
  });
});
