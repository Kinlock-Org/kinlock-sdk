import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Country-agnostic core (AGENTS.md hard rule 11, roadmap M3-24): "Don't assume Nigeria, naira, or
 * any single market in code, tests, fixtures, copy, or examples." Country and currency are
 * registry data; nothing here may name one market by hand. Catches a regression of the exact
 * historical pattern this project moved away from (docs/PRD.md's v0.3 changelog: "no longer
 * 'abroad to Nigeria'"), not a general ban on every country/currency word.
 *
 * Mirrors kinlock-app's lib/country-agnostic.test.ts; kept in sync by hand (no shared package
 * between the two repos for a ten-line check).
 */
const BANNED = [/\bnigeria\b/i, /\bnaira\b/i, /\bngn\b/i, /\blagos\b/i];

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXCLUDED_SUFFIXES = [".test.ts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!path.endsWith(".ts")) return [];
    if (EXCLUDED_SUFFIXES.some((suffix) => path.endsWith(suffix))) return [];
    return [path];
  });
}

const findings = (source: string): string[] =>
  BANNED.filter((pattern) => pattern.test(source)).map((pattern) => pattern.source);

describe("country-agnostic core: no hard-coded single-market terms", () => {
  const files = sourceFiles(srcRoot);

  it("scans the SDK's source", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("%s", (file) => {
    expect(findings(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("would catch a hard-coded market assumption", () => {
    expect(findings("const defaultCountry = 'Nigeria';")).toContain("\\bnigeria\\b");
    expect(findings('label: "Pay in naira"')).toContain("\\bnaira\\b");
    expect(findings('const code = "NGN";')).toContain("\\bngn\\b");
    expect(findings("country.displayName")).toEqual([]);
  });
});
