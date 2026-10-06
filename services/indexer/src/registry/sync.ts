/**
 * Joins payee display data from the public registry repo (roadmap M2-13, M2-19).
 *
 * Registry files are untrusted input. A file's fields are shown only when the file is bound to
 * what was registered on-chain:
 *   - payee_id == sha256(slug), and
 *   - meta_hash == sha256(canonical JSON of the whole file), and
 *   - the category matches.
 * The attester handle is shown only if attesters/<handle>.json has the on-chain attester address.
 * Anything else (missing, malformed, edited after registration) leaves the fields null.
 * Country and currency are display and filter data only; nothing branches on them.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { payees } from "../db/schema.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Sorted keys, no whitespace, UTF-8: the registry's `meta_hash` input (ARCHITECTURE.md §5.3). */
export function canonicalize(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k] as Json)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const PayeeFile = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  display_name: z.string().min(1).max(160),
  category: z.enum(["School", "Rent"]),
  country: z.string().regex(/^[A-Z]{2}$/),
  local_currency: z.string().regex(/^[A-Z]{3}$/),
  city: z.string().min(1).max(120),
  attester: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
});

const AttesterFile = z.object({ handle: z.string(), address: z.string() });

interface RegistryEntry {
  file: string;
  metaHash: string;
  payee: z.infer<typeof PayeeFile>;
}

export interface SyncResult {
  /** Payees whose registry fields are now shown. */
  joined: number;
  /** On-chain payees with no valid, hash-matching registry file (fields cleared). */
  unmatched: string[];
  /** Files that couldn't be read or parsed. */
  invalidFiles: string[];
}

const jsonFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory()
        ? jsonFiles(join(dir, d.name))
        : d.name.endsWith(".json")
          ? [join(dir, d.name)]
          : [],
    );
  } catch {
    return [];
  }
};

/** Read a registry tree (`payees/<country>/<slug>.json`, `attesters/<handle>.json`). */
export function readRegistry(root: string) {
  const invalidFiles: string[] = [];
  const read = (file: string): Json | undefined => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Json;
    } catch {
      invalidFiles.push(file);
      return undefined;
    }
  };

  const entries = new Map<string, RegistryEntry>();
  for (const file of jsonFiles(join(root, "payees"))) {
    const raw = read(file);
    const parsed = PayeeFile.safeParse(raw);
    if (!parsed.success) {
      if (raw !== undefined) invalidFiles.push(file);
      continue;
    }
    entries.set(sha256Hex(parsed.data.slug), {
      file,
      metaHash: sha256Hex(canonicalize(raw as Json)),
      payee: parsed.data,
    });
  }

  const attesters = new Map<string, string>();
  for (const file of jsonFiles(join(root, "attesters"))) {
    const parsed = AttesterFile.safeParse(read(file));
    if (parsed.success) attesters.set(parsed.data.handle, parsed.data.address);
    else invalidFiles.push(file);
  }
  return { entries, attesters, invalidFiles };
}

/** Bring every payee row's registry fields in line with the registry tree at `root`. */
export async function syncRegistry(db: Db, root: string): Promise<SyncResult> {
  const { entries, attesters, invalidFiles } = readRegistry(root);
  const rows = await db.select().from(payees);
  const unmatched: string[] = [];
  let joined = 0;

  for (const row of rows) {
    const entry = entries.get(row.payeeId);
    const bound =
      entry !== undefined &&
      entry.metaHash === row.metaHash &&
      entry.payee.category === row.category;
    const next = bound
      ? {
          slug: entry.payee.slug,
          displayName: entry.payee.display_name,
          country: entry.payee.country,
          localCurrency: entry.payee.local_currency,
          city: entry.payee.city,
          attesterHandle:
            attesters.get(entry.payee.attester) === row.attester ? entry.payee.attester : null,
        }
      : {
          slug: null,
          displayName: null,
          country: null,
          localCurrency: null,
          city: null,
          attesterHandle: null,
        };
    if (bound) joined++;
    else unmatched.push(row.payeeId);

    const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => row[k] !== next[k]);
    if (changed) await db.update(payees).set(next).where(eq(payees.payeeId, row.payeeId));
  }
  return { joined, unmatched, invalidFiles };
}
