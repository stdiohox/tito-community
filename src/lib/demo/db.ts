import "server-only";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { cookies } from "next/headers";
import type { PGlite } from "@electric-sql/pglite";
import { DEMO_COOKIES } from "@/lib/demo/mode";
import { DEMO_SCHEMA, demoSeedSql } from "@/lib/demo/seed";
import { demoMac, macMatches, mintSid, verifySid } from "@/lib/demo/token";

/*
 * Each visitor gets a private copy of the sample data: a clone of one seeded
 * in-process Postgres (PGlite) that ran the REAL migrations. Their changes
 * never reach anyone else, and there is no real database anywhere.
 *
 * STATE ACROSS SERVERLESS INSTANCES. Vercel may serve a page and the form
 * action behind it from different instances, so a visitor's database cannot
 * live only in memory. Every change is also appended to a signed, compressed
 * log in the visitor's own cookie, and the cookie is the source of truth:
 * on every request the in-memory copy catches up with it (or is rebuilt from
 * the seed if it has diverged).
 *
 * Replay is deterministic where it matters: inserts are logged as the full
 * rows the database produced (ids and timestamps included), so a pick keeps
 * its id and its URL. Updates, deletes and RPC calls are logged as executed.
 * The log is HMAC-signed, so a visitor cannot feed the server SQL.
 *
 * RESOURCE LIMITS. The demo is public and each copy costs a few hundred MB:
 *   - sandbox ids are minted (and signed) only by the proxy; a request
 *     without a valid one is refused, never given a fresh database;
 *   - copies are built one at a time per instance, and at most
 *     MAX_VISITORS are kept (least recently used dropped first; a dropped
 *     copy is freed once in-flight requests release it, never closed under
 *     them);
 *   - each visitor's log and uploads are capped.
 */

export type Claims = { role: string; sub?: string; aal?: string; email?: string; [k: string]: unknown };
type LogEntry = { s: string; p: unknown[]; c: Claims | null };

export type Visitor = {
  sid: string;
  db: PGlite;
  log: LogEntry[];
  /** Chart images uploaded this session. Not in the log (too large); a generated chart stands in after a rebuild. */
  uploads: Map<string, { type: string; bytes: Uint8Array }>;
  chain: Promise<unknown>;
  lastUsed: number;
  /** The log outgrew the cookie: changes still apply, but only on this instance. */
  overBudget: boolean;
};

export class DemoSessionError extends Error {}

const MAX_VISITORS = 2;
const MAX_LOG_ENTRIES = 300;
const CHUNK = 3800;
const MAX_CHUNKS = 3; // ~11 KB: with the session cookie, safely under a 16 KB header limit
export const MAX_UPLOADS = { count: 6, bytes: 8 * 1024 * 1024 };

let seedPromise: Promise<PGlite> | null = null;
const visitors = new Map<string, Visitor>();
const building = new Map<string, Promise<Visitor>>();
let buildQueue: Promise<unknown> = Promise.resolve();

function sqlFile(...parts: string[]) {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

async function buildSeed(): Promise<PGlite> {
  const { PGlite } = await import("@electric-sql/pglite");
  const started = Date.now();
  // Fast path: the schema snapshot made at build time (prebuild), so a cold
  // server skips initdb and every migration.
  const snapshot = join(process.cwd(), ".demo", "schema.tar.gz");
  const fromSnapshot = existsSync(snapshot);
  let db: PGlite;
  if (fromSnapshot) {
    db = new PGlite({ loadDataDir: new Blob([readFileSync(snapshot)]) });
    await db.waitReady;
  } else {
    db = new PGlite();
    await db.exec(sqlFile("scripts", "supabase-stubs.sql"));
    const dir = join(process.cwd(), "supabase", "migrations");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      await db.exec(readFileSync(join(dir, f), "utf8"));
    }
    await db.exec(DEMO_SCHEMA);
  }
  // Sample data always at run time, so its dates are relative to now.
  await db.exec(demoSeedSql());
  console.log(`[demo] seed database ready in ${Date.now() - started}ms (${fromSnapshot ? "snapshot" : "fresh"})`);
  return db;
}

function seed(): Promise<PGlite> {
  seedPromise ??= buildSeed().catch((e) => {
    seedPromise = null;
    throw e;
  });
  return seedPromise;
}

// ---------------------------------------------------------------------------
// The visitor's log cookie
// ---------------------------------------------------------------------------
const cookieOpts = () => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
});

function encodeLog(sid: string, log: LogEntry[]): string {
  const payload = deflateRawSync(Buffer.from(JSON.stringify({ sid, e: log }))).toString("base64url");
  return `${demoMac("log", payload).toString("base64url")}.${payload}`;
}

function decodeLog(sid: string, value: string): LogEntry[] {
  const dot = value.indexOf(".");
  if (dot < 0) return [];
  const payload = value.slice(dot + 1);
  // Signature first: nothing unverified is ever inflated or parsed.
  if (!macMatches("log", payload, value.slice(0, dot))) return [];
  try {
    const parsed = JSON.parse(inflateRawSync(Buffer.from(payload, "base64url")).toString()) as { sid: string; e: LogEntry[] };
    return parsed.sid === sid ? parsed.e : [];
  } catch {
    return [];
  }
}

function readLog(jar: Awaited<ReturnType<typeof cookies>>, sid: string): LogEntry[] {
  const chunks: string[] = [];
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const c = jar.get(`${DEMO_COOKIES.log}.${i}`)?.value;
    if (!c) break;
    chunks.push(c);
  }
  return chunks.length ? decodeLog(sid, chunks.join("")) : [];
}

/**
 * Writes the visitor's log to their cookie. Possible in Server Actions and
 * Route Handlers; a page render cannot set cookies, and the in-memory copy
 * simply stays ahead until the next action writes the full log.
 */
async function persistLog(v: Visitor): Promise<void> {
  const parts = encodeLog(v.sid, v.log).match(new RegExp(`.{1,${CHUNK}}`, "g")) ?? [];
  if (parts.length > MAX_CHUNKS) {
    v.overBudget = true;
    return;
  }
  try {
    const jar = await cookies();
    parts.forEach((p, i) => jar.set(`${DEMO_COOKIES.log}.${i}`, p, cookieOpts()));
    for (let i = parts.length; i < MAX_CHUNKS; i++) {
      if (jar.get(`${DEMO_COOKIES.log}.${i}`)) jar.delete(`${DEMO_COOKIES.log}.${i}`);
    }
  } catch {
    // Page render: read-only cookies.
  }
}

// ---------------------------------------------------------------------------
// Visitors
// ---------------------------------------------------------------------------
async function currentSid(): Promise<{ sid: string; jar: Awaited<ReturnType<typeof cookies>> }> {
  const jar = await cookies();
  const sid = verifySid(jar.get(DEMO_COOKIES.sid)?.value);
  if (!sid) {
    // Never conjure a sandbox here: that would let any request allocate a
    // new database. The proxy mints sandbox ids on page requests.
    throw new DemoSessionError("No demo session. Open the demo in a browser first.");
  }
  return { sid, jar };
}

async function withClaims(db: PGlite, claims: Claims | null, fn: () => Promise<void>) {
  await db.exec("begin");
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [claims ? JSON.stringify(claims) : ""]);
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [claims?.sub ?? ""]);
    await fn();
    await db.exec("commit");
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

async function replay(db: PGlite, log: LogEntry[]): Promise<void> {
  for (const entry of log) {
    try {
      // Replayed as the owner (RLS was enforced when the change was first
      // made), but with the original claims, so functions that check
      // auth.uid() or aal behave the same and the audit log names the same person.
      await withClaims(db, entry.c, async () => {
        await db.query(entry.s, entry.p);
      });
    } catch (e) {
      console.warn(`[demo] replay skipped an entry: ${e instanceof Error ? e.message : e}`);
    }
  }
}

const same = (a: LogEntry, b: LogEntry) => JSON.stringify(a) === JSON.stringify(b);
const isPrefix = (short: LogEntry[], long: LogEntry[]) => short.length <= long.length && short.every((e, i) => same(e, long[i]));

/** Builds one copy at a time per instance, so a burst of visitors cannot spike memory. */
function build(sid: string, log: LogEntry[]): Promise<Visitor> {
  const pending = buildQueue.then(async () => {
    const db = (await (await seed()).clone()) as PGlite;
    await replay(db, log);
    const v: Visitor = { sid, db, log: [...log], uploads: new Map(), chain: Promise.resolve(), lastUsed: Date.now(), overBudget: false };
    visitors.set(sid, v);
    // Dropped copies are not closed here: a request may still be using one.
    // Once nothing references it, it is garbage-collected.
    while (visitors.size > MAX_VISITORS) {
      const oldest = [...visitors.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      visitors.delete(oldest.sid);
    }
    return v;
  });
  buildQueue = pending.catch(() => undefined);
  return pending;
}

function buildOnce(sid: string, log: LogEntry[]): Promise<Visitor> {
  let pending = building.get(sid);
  if (!pending) {
    pending = build(sid, log).finally(() => building.delete(sid));
    building.set(sid, pending);
  }
  return pending;
}

/** This request's visitor, caught up with (or rebuilt from) their cookie log. */
export async function currentVisitor(): Promise<Visitor> {
  const { sid, jar } = await currentSid();
  const cookieLog = readLog(jar, sid);
  let v = visitors.get(sid) ?? (await buildOnce(sid, cookieLog));

  // Inside the visitor's lock, so no write can interleave with the check.
  const state = await serial(v, async () => {
    if (isPrefix(cookieLog, v.log)) return "current"; // up to date, or ahead (not yet persisted)
    if (isPrefix(v.log, cookieLog)) {
      const missing = cookieLog.slice(v.log.length);
      await replay(v.db, missing);
      v.log.push(...missing);
      return "current";
    }
    return "diverged";
  });
  if (state === "diverged") {
    if (visitors.get(sid) === v) visitors.delete(sid);
    v = await buildOnce(sid, cookieLog);
  }
  v.lastUsed = Date.now();
  return v;
}

/** Back to the untouched sample data, in a brand-new sandbox. */
export async function resetVisitor(): Promise<void> {
  const { sid, jar } = await currentSid();
  visitors.delete(sid);
  for (let i = 0; i < MAX_CHUNKS; i++) {
    try {
      jar.delete(`${DEMO_COOKIES.log}.${i}`);
    } catch {
      /* page render */
    }
  }
  // A new sandbox id, so copies other instances still hold for the old one
  // are never used again.
  jar.set(DEMO_COOKIES.sid, mintSid(), cookieOpts());
}

/** Whether this visitor's changes have outgrown what the demo can keep. */
export async function demoStorageFull(): Promise<boolean> {
  try {
    const { sid } = await currentSid();
    const v = visitors.get(sid);
    return Boolean(v && (v.overBudget || v.log.length >= MAX_LOG_ENTRIES));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Running statements
// ---------------------------------------------------------------------------
/** Runs one unit of work on the visitor's database, one at a time per visitor. */
export function serial<T>(v: Visitor, fn: () => Promise<T>): Promise<T> {
  const next = v.chain.then(fn, fn);
  v.chain = next.catch(() => undefined);
  return next;
}

export type ExecOptions = {
  claims: Claims | null;
  /** Run with RLS as this role. Null = as the owner (demo internals). */
  role: "anon" | "authenticated" | "service_role" | null;
  /** Record the statement as executed in the visitor's log. */
  persist?: boolean;
  /**
   * Record the rows it inserted (with `returning *`) as explicit full-row
   * inserts into this table, so replay reproduces ids and timestamps.
   */
  persistRowsOf?: string;
};

/**
 * Executes a statement as the given role and claims, inside a transaction.
 * The statement and its log record happen under one lock, so the log is
 * always in the order the changes were made.
 */
export async function exec<T = Record<string, unknown>>(
  v: Visitor,
  sql: string,
  params: unknown[],
  opts: ExecOptions,
): Promise<{ rows: T[]; fields: { name: string }[]; affectedRows?: number }> {
  return serial(v, async () => {
    if ((opts.persist || opts.persistRowsOf) && v.log.length >= MAX_LOG_ENTRIES) {
      throw new DemoSessionError("This demo session is full. Use “Reset sample data” in the persona switcher.");
    }
    let result!: { rows: T[]; fields: { name: string }[]; affectedRows?: number };
    await withClaims(v.db, opts.claims, async () => {
      if (opts.role) await v.db.exec(`set local role ${opts.role}`);
      result = await v.db.query<T>(sql, params);
    });
    if (opts.persist) await recordLocked(v, sql, params, opts.claims);
    if (opts.persistRowsOf) await recordRowsLocked(v, opts.persistRowsOf, result.rows as Record<string, unknown>[], opts.claims);
    return result;
  });
}

/** Adds an entry to the log (caller holds the visitor's lock) and writes the cookie. */
async function recordLocked(v: Visitor, sql: string, params: unknown[], claims: Claims | null): Promise<void> {
  v.log.push({ s: sql, p: params.map(jsonSafe), c: claims });
  await persistLog(v);
}

/** Adds an entry to the log under the visitor's lock. */
export function record(v: Visitor, sql: string, params: unknown[], claims: Claims | null): Promise<void> {
  return serial(v, () => recordLocked(v, sql, params, claims));
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return null;
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

const identityCache = new Map<string, Set<string>>();

async function recordRowsLocked(v: Visitor, table: string, rows: Record<string, unknown>[], claims: Claims | null): Promise<void> {
  if (rows.length === 0) return;
  let identity = identityCache.get(table);
  if (!identity) {
    const [schema, name] = table.includes(".") ? table.split(".") : ["public", table];
    const res = await v.db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = $1 and table_name = $2 and is_identity = 'YES'`,
      [schema, name],
    );
    identity = new Set(res.rows.map((r) => r.column_name));
    identityCache.set(table, identity);
  }
  const target = table.includes(".") ? table : `public.${table}`;
  for (const row of rows) {
    const cols = Object.keys(row).filter((c) => !identity.has(c));
    v.log.push({
      s: `insert into ${target} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) on conflict do nothing`,
      p: cols.map((c) => jsonSafe(row[c])),
      c: claims,
    });
  }
  await persistLog(v);
}

/** For demo internals that read freely (charts, the outbox, the checkout page). */
export async function ownerQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const v = await currentVisitor();
  return (await exec<T>(v, sql, params, { claims: null, role: null })).rows;
}
