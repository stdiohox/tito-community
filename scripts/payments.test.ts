/**
 * End-to-end payment tests: the REAL processReference() and the REAL webhook
 * route handler, running against the REAL migrations in PGlite. Only the
 * network is faked (scripts/fake-network.ts): Paystack verify, and Supabase
 * REST translated to SQL.
 *
 *   npm run test:payments
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createFakeNetwork, PAYSTACK_KEY, setTestEnv } from "./fake-network";

setTestEnv();
let net: Awaited<ReturnType<typeof createFakeNetwork>>;
let db: typeof net.db;
let paystack: typeof net.paystack.transactions;

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
  net = await createFakeNetwork();
  db = net.db;
  paystack = net.paystack.transactions;
  await db.query(`insert into auth.users (id, email) values ($1, 'member@example.test'), ($2, 'lapsed@example.test')`, [MEMBER, LAPSED]);
  await db.query(`insert into public.entitlements (user_id, access_ends_at) values ($1, now() + interval '30 days'), ($2, now() - interval '40 days')`, [MEMBER, LAPSED]);
  const p = await db.query<{ id: string }>(
    `insert into public.products (name, price_kobo, access_months, paystack_plan_code) values ('Circle 6', 30000000, 6, $1) returning id`,
    [PLAN],
  );
  productId = p.rows[0].id;
});

after(async () => {
  await net.close();
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
