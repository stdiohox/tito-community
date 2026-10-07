/**
 * Test harness: replaces global fetch so the app's REAL server code runs
 * against the REAL migrations in PGlite, with only the network faked:
 *
 *   - Supabase REST (PostgREST) -> SQL on PGlite, as the service role. Only
 *     the request shapes the app's service-role code uses are supported.
 *   - Paystack API -> in-memory fixtures (transactions, plans).
 *
 * Every test file sets env vars, calls createFakeNetwork(), then imports the
 * modules under test.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

export const SUPABASE_URL = "http://supabase.test";
export const PAYSTACK_KEY = "sk_test_unit";

export function setTestEnv() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
  process.env.PAYSTACK_SECRET_KEY = PAYSTACK_KEY;
}

export type FakePlan = { plan_code: string; name: string; amount: number; interval: string; createdAt: string };

export async function createFakeNetwork() {
  const db = new PGlite();
  await db.exec(readFileSync(join(process.cwd(), "scripts", "supabase-stubs.sql"), "utf8"));
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }

  const paystack = {
    transactions: new Map<string, Record<string, unknown>>(),
    plans: [] as FakePlan[],
    planPosts: 0,
    failNextPlanPost: false,
    /** Delay inside POST /plan, to let concurrent callers overlap. */
    planPostDelayMs: 0,
  };

  /** Resend: every POST /emails, and an optional queue of canned failures. */
  const resend = {
    sent: [] as { to: string; idempotencyKey: string | null }[],
    failNext: [] as { status: number; name: string }[],
  };

  // PGlite is one connection: serialise every simulated request so role
  // switches never interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const asService = <T>(fn: () => Promise<T>) =>
    serial(async () => {
      await db.exec("set role service_role");
      try {
        return await fn();
      } finally {
        await db.exec("reset role");
      }
    });

  function filters(params: URLSearchParams) {
    const where: string[] = [];
    const values: unknown[] = [];
    for (const [key, raw] of params) {
      if (["select", "limit", "order", "on_conflict", "offset"].includes(key)) continue;
      if (!/^[a-z_]+$/.test(key)) throw new Error(`bad column ${key}`);
      let v = raw;
      let neg = false;
      if (v.startsWith("not.")) {
        neg = true;
        v = v.slice(4);
      }
      let clause: string;
      if (v === "is.null") clause = `${key} is null`;
      else if (v.startsWith("in.(")) {
        values.push(v.slice(4, -1).split(",").map((x) => x.replace(/^"|"$/g, "")));
        clause = `${key}::text = any($${values.length}::text[])`;
      } else {
        const m = v.match(/^(eq|lt|lte|gt|gte)\.(.*)$/);
        if (!m) throw new Error(`unsupported filter ${key}=${raw}`);
        const op = { eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" }[m[1]]!;
        values.push(m[2]);
        clause = `${key} ${op} $${values.length}`;
      }
      where.push(neg ? `not (${clause})` : clause);
    }
    return { where: where.length ? ` where ${where.join(" and ")}` : "", values };
  }

  async function supabaseRest(url: URL, init: RequestInit): Promise<Response> {
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const fail = (e: unknown) =>
      Response.json({ message: (e as Error).message, code: (e as { code?: string }).code ?? "P0001" }, { status: 400 });

    if (path.startsWith("rpc/")) {
      const fn = path.slice(4);
      const args = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      const names = Object.keys(args);
      const sql = `select * from public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`;
      try {
        const res = await asService(() => db.query<Record<string, unknown>>(sql, Object.values(args)));
        const scalar = res.fields.length === 1 && res.fields[0].name === fn;
        return Response.json(scalar ? res.rows[0]?.[fn] ?? null : res.rows);
      } catch (e) {
        return fail(e);
      }
    }

    const table = path;
    if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table ${table}`);
    const { where, values } = filters(url.searchParams);
    const select = url.searchParams.get("select") ?? "*";
    const single = headers.get("accept")?.includes("vnd.pgrst.object");

    try {
      if (method === "GET") {
        const res = await asService(() => db.query(`select ${select} from public.${table}${where}`, values));
        if (!single) return Response.json(res.rows);
        if (res.rows.length !== 1) {
          return Response.json(
            { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${res.rows.length} rows` },
            { status: 406 },
          );
        }
        return Response.json(res.rows[0]);
      }
      if (method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const cols = Object.keys(body);
        const set = cols.map((c, i) => `${c} = $${values.length + i + 1}`).join(", ");
        await asService(() => db.query(`update public.${table} set ${set}${where}`, [...values, ...Object.values(body)]));
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        await asService(() => db.query(`delete from public.${table}${where}`, values));
        return new Response(null, { status: 204 });
      }
    } catch (e) {
      return fail(e);
    }
    throw new Error(`unsupported ${method} ${url}`);
  }

  async function paystackApi(url: URL, init: RequestInit): Promise<Response> {
    if (new Headers(init.headers).get("authorization") !== `Bearer ${PAYSTACK_KEY}`) {
      return Response.json({ status: false, message: "Invalid key" }, { status: 401 });
    }
    const method = (init.method ?? "GET").toUpperCase();
    const verify = url.pathname.match(/^\/transaction\/verify\/(.+)$/);
    if (verify) {
      const tx = paystack.transactions.get(decodeURIComponent(verify[1]));
      if (!tx) return Response.json({ status: false, message: "Transaction reference not found" }, { status: 404 });
      return Response.json({ status: true, message: "ok", data: tx });
    }
    if (url.pathname === "/plan" && method === "GET") {
      const amount = Number(url.searchParams.get("amount"));
      const interval = url.searchParams.get("interval");
      const data = paystack.plans.filter((p) => p.amount === amount && p.interval === interval);
      return Response.json({ status: true, message: "ok", data, meta: { pageCount: 1 } });
    }
    if (url.pathname === "/plan" && method === "POST") {
      paystack.planPosts++;
      if (paystack.planPostDelayMs) await new Promise((r) => setTimeout(r, paystack.planPostDelayMs));
      if (paystack.failNextPlanPost) {
        paystack.failNextPlanPost = false;
        return Response.json({ status: false, message: "Paystack is down" }, { status: 503 });
      }
      const body = JSON.parse(String(init.body)) as { name: string; amount: number; interval: string };
      const plan = { plan_code: `PLN_${paystack.plans.length + 1}`, ...body, createdAt: new Date().toISOString() };
      paystack.plans.push(plan);
      return Response.json({ status: true, message: "Plan created", data: plan });
    }
    throw new Error(`unexpected Paystack call ${method} ${url}`);
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const merged: RequestInit = req
      ? { method: req.method, headers: req.headers, body: req.body ? await req.text() : undefined, ...init }
      : init;
    if (url.origin === SUPABASE_URL) return supabaseRest(url, merged);
    if (url.origin === "https://api.paystack.co") return paystackApi(url, merged);
    if (url.origin === "https://api.resend.com" && url.pathname === "/emails") {
      const body = JSON.parse(String(merged.body)) as { to: string | string[] };
      const failure = resend.failNext.shift();
      if (failure) {
        return Response.json({ statusCode: failure.status, name: failure.name, message: "canned failure" }, { status: failure.status });
      }
      resend.sent.push({
        to: Array.isArray(body.to) ? body.to[0] : body.to,
        idempotencyKey: new Headers(merged.headers).get("idempotency-key"),
      });
      return Response.json({ id: `email_${resend.sent.length}` });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  return {
    db,
    paystack,
    resend,
    async close() {
      globalThis.fetch = realFetch;
      await db.close();
    },
  };
}
