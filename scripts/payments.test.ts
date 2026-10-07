/**
 * End-to-end payment tests: the REAL processReference() and the REAL webhook
 * route handler, running against the REAL migration in PGlite.
 *
 * Only two things are faked, both at the network boundary:
 *   - Paystack's API (transaction verify), served from fixtures below;
 *   - Supabase's REST API, translated to SQL against PGlite. Just the handful
 *     of PostgREST calls the payment path makes are supported.
 *
 *   npm run test:payments
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const SUPABASE_URL = "http://supabase.test";
const PAYSTACK_KEY = "sk_test_unit";

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
process.env.PAYSTACK_SECRET_KEY = PAYSTACK_KEY;

const db = new PGlite();
const paystack = new Map<string, Record<string, unknown>>();

const STUBS = readFileSync(join(process.cwd(), "scripts", "supabase-stubs.sql"), "utf8");

// ---------------------------------------------------------------------------
// Fake network
// ---------------------------------------------------------------------------
function filters(params: URLSearchParams) {
  const where: string[] = [];
  const values: unknown[] = [];
  for (const [key, raw] of params) {
    if (["select", "limit", "order", "on_conflict"].includes(key)) continue;
    if (!/^[a-z_]+$/.test(key)) throw new Error(`bad column ${key}`);
    if (raw === "is.null") where.push(`${key} is null`);
    else if (raw.startsWith("eq.")) {
      values.push(raw.slice(3));
      where.push(`${key} = $${values.length}`);
    } else throw new Error(`unsupported filter ${key}=${raw}`);
  }
  return { where: where.length ? `where ${where.join(" and ")}` : "", values };
}

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

async function supabaseRest(url: URL, init: RequestInit): Promise<Response> {
  const path = url.pathname.replace(/^\/rest\/v1\//, "");
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);

  if (path.startsWith("rpc/")) {
    const fn = path.slice(4);
    const args = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    const names = Object.keys(args);
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`;
    try {
      const res = await asService(() => db.query<{ r: unknown }>(sql, Object.values(args)));
      return Response.json(res.rows[0].r);
    } catch (e) {
      return Response.json({ message: (e as Error).message, code: "P0001" }, { status: 400 });
    }
  }

  const table = path;
  if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table ${table}`);
  const { where, values } = filters(url.searchParams);

  if (method === "GET") {
    const select = url.searchParams.get("select") ?? "*";
    const res = await asService(() => db.query(`select ${select} from public.${table} ${where}`, values));
    const single = headers.get("accept")?.includes("vnd.pgrst.object");
    if (!single) return Response.json(res.rows);
    if (res.rows.length !== 1) {
      return Response.json({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${res.rows.length} rows` }, { status: 406 });
    }
    return Response.json(res.rows[0]);
  }

  if (method === "PATCH") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const cols = Object.keys(body);
    const set = cols.map((c, i) => `${c} = $${values.length + i + 1}`).join(", ");
    await asService(() => db.query(`update public.${table} set ${set} ${where}`, [...values, ...Object.values(body)]));
    return new Response(null, { status: 204 });
  }

  throw new Error(`unsupported ${method} ${url}`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const req = input instanceof Request ? input : null;
  const url = new URL(req ? req.url : String(input));
  const merged: RequestInit = req
    ? { method: req.method, headers: req.headers, body: req.body ? await req.text() : undefined, ...init }
    : init;

  if (url.origin === SUPABASE_URL) return supabaseRest(url, merged);

  if (url.origin === "https://api.paystack.co") {
    assert.equal(new Headers(merged.headers).get("authorization"), `Bearer ${PAYSTACK_KEY}`);
    const m = url.pathname.match(/^\/transaction\/verify\/(.+)$/);
    if (m) {
      const tx = paystack.get(decodeURIComponent(m[1]));
      if (!tx) return Response.json({ status: false, message: "Transaction reference not found" }, { status: 404 });
      return Response.json({ status: true, message: "ok", data: tx });
    }
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const MEMBER = "00000000-0000-4000-8000-0000000000a1";
const LAPSED = "00000000-0000-4000-8000-0000000000a2";
let productId = "";
const PLAN = "PLN_test_6m";

function charge(reference: string, over: Partial<Record<string, unknown>> = {}) {
  paystack.set(reference, {
    status: "success",
    reference,
    amount: 30_000_000,
    currency: "NGN",
    paid_at: new Date().toISOString(),
    customer: { email: "member@example.test", customer_code: "CUS_member" },
    plan: null,
    ...over,
  });
}

async function intent(reference: string, userId: string, kind: "one_off" | "subscription" = "one_off") {
  await db.query(
    `insert into public.checkout_intents (reference, user_id, product_id, kind, amount_kobo, plan_code) values ($1, $2, $3, $4, 30000000, $5)`,
    [reference, userId, productId, kind, kind === "subscription" ? PLAN : null],
  );
}

async function endsAt(userId: string): Promise<Date> {
  const r = await db.query<{ e: string }>(`select access_ends_at::text e from public.entitlements where user_id = $1`, [userId]);
  return new Date(r.rows[0].e);
}

const ref = (n: number) => `tc_${n.toString(16).padStart(32, "0")}`;

before(async () => {
  await db.exec(STUBS);
  for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join("supabase/migrations", f), "utf8"));
  }
  await db.query(`insert into auth.users (id, email) values ($1, 'member@example.test'), ($2, 'lapsed@example.test')`, [MEMBER, LAPSED]);
  await db.query(`insert into public.entitlements (user_id, access_ends_at) values ($1, now() + interval '30 days'), ($2, now() - interval '40 days')`, [MEMBER, LAPSED]);
  const p = await db.query<{ id: string }>(
    `insert into public.products (name, price_kobo, access_months, paystack_plan_code) values ('Circle 6', 30000000, 6, $1) returning id`,
    [PLAN],
  );
  productId = p.rows[0].id;
});

after(async () => {
  globalThis.fetch = realFetch;
  await db.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("processReference", () => {
  test("early renewal stacks six months on the current end date, and binds the customer code", async () => {
    const { processReference } = await import("../src/lib/payments");
    const before = await endsAt(MEMBER);
    await intent(ref(1), MEMBER);
    charge(ref(1));

    const r = await processReference(ref(1));
    assert.equal(r.state, "recorded");
    const expected = new Date(before);
    expected.setMonth(expected.getMonth() + 6);
    assert.equal((await endsAt(MEMBER)).getTime(), expected.getTime());

    const code = await db.query<{ c: string }>(`select paystack_customer_code c from public.profiles where user_id = $1`, [MEMBER]);
    assert.equal(code.rows[0].c, "CUS_member");
  });

  test("a replayed reference changes nothing", async () => {
    const { processReference } = await import("../src/lib/payments");
    const before = await endsAt(MEMBER);
    const r = await processReference(ref(1));
    assert.equal(r.state, "duplicate");
    assert.equal((await endsAt(MEMBER)).getTime(), before.getTime());
    const n = await db.query<{ n: number }>(`select count(*)::int n from public.payments`);
    assert.equal(n.rows[0].n, 1);
  });

  test("a lapsed member's new term starts at payment time, not at the old end date", async () => {
    const { processReference } = await import("../src/lib/payments");
    const paidAt = new Date();
    await intent(ref(2), LAPSED);
    charge(ref(2), { paid_at: paidAt.toISOString(), customer: { email: "lapsed@example.test", customer_code: "CUS_lapsed" } });
    assert.equal((await processReference(ref(2))).state, "recorded");
    const expected = new Date(paidAt);
    expected.setMonth(expected.getMonth() + 6);
    assert.equal((await endsAt(LAPSED)).getTime(), expected.getTime());
  });

  test("an amount that differs from the checkout intent is rejected", async () => {
    const { processReference } = await import("../src/lib/payments");
    const before = await endsAt(MEMBER);
    await intent(ref(3), MEMBER);
    charge(ref(3), { amount: 100 });
    const r = await processReference(ref(3));
    assert.equal(r.state, "rejected");
    assert.equal((await endsAt(MEMBER)).getTime(), before.getTime());
  });

  test("an unfinished transaction is pending and grants nothing", async () => {
    const { processReference } = await import("../src/lib/payments");
    await intent(ref(4), MEMBER);
    charge(ref(4), { status: "abandoned" });
    assert.equal((await processReference(ref(4))).state, "pending");
  });

  test("a payment this app never started (no intent, no plan) is rejected, whatever its metadata says", async () => {
    const { processReference } = await import("../src/lib/payments");
    charge(ref(5), { metadata: { user_id: MEMBER, product_id: productId } });
    const r = await processReference(ref(5));
    assert.equal(r.state, "rejected");
  });

  test("an auto-renewal charge (no intent) is matched by plan and customer code, and stacks", async () => {
    const { processReference } = await import("../src/lib/payments");
    const before = await endsAt(MEMBER);
    charge("T_recurring_1", { plan: { plan_code: PLAN } });
    const r = await processReference("T_recurring_1");
    assert.equal(r.state, "recorded");
    const expected = new Date(before);
    expected.setMonth(expected.getMonth() + 6);
    assert.equal((await endsAt(MEMBER)).getTime(), expected.getTime());
    const k = await db.query<{ kind: string }>(`select kind from public.payments where reference = 'T_recurring_1'`);
    assert.equal(k.rows[0].kind, "renewal");
  });

  test("an auto-renewal for an unknown customer is rejected", async () => {
    const { processReference } = await import("../src/lib/payments");
    charge("T_recurring_2", { plan: PLAN, customer: { email: "stranger@example.test", customer_code: "CUS_stranger" } });
    assert.equal((await processReference("T_recurring_2")).state, "rejected");
  });

  test("a subscription checkout must be charged on the plan it was started with", async () => {
    const { processReference } = await import("../src/lib/payments");
    await intent(ref(6), MEMBER, "subscription");
    charge(ref(6), { plan: "PLN_other" });
    assert.equal((await processReference(ref(6))).state, "rejected");
  });
});

describe("webhook route", () => {
  const sign = (body: string) => createHmac("sha512", PAYSTACK_KEY).update(body).digest("hex");

  test("rejects a missing or wrong signature before doing anything", async () => {
    const { POST } = await import("../src/app/api/paystack/webhook/route");
    const body = JSON.stringify({ event: "charge.success", data: { reference: ref(7) } });
    const none = await POST(new Request("http://x/api/paystack/webhook", { method: "POST", body }));
    assert.equal(none.status, 401);
    const wrong = await POST(
      new Request("http://x/api/paystack/webhook", { method: "POST", body, headers: { "x-paystack-signature": sign(body + " ") } }),
    );
    assert.equal(wrong.status, 401);
  });

  test("a signed charge.success grants access once; the replay is a no-op", async () => {
    const { POST } = await import("../src/app/api/paystack/webhook/route");
    const before = await endsAt(LAPSED);
    await intent(ref(8), LAPSED);
    charge(ref(8), { customer: { email: "lapsed@example.test", customer_code: "CUS_lapsed" } });
    const body = JSON.stringify({ event: "charge.success", data: { reference: ref(8) } });
    const send = () =>
      POST(new Request("http://x/api/paystack/webhook", { method: "POST", body, headers: { "x-paystack-signature": sign(body) } }));

    assert.equal((await send()).status, 200);
    const once = await endsAt(LAPSED);
    assert.ok(once > before);
    assert.equal((await send()).status, 200);
    assert.equal((await endsAt(LAPSED)).getTime(), once.getTime());
  });
});
