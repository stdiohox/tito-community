/**
 * Tests for the four pre-launch fixes, running the REAL server modules
 * against the REAL migrations (scripts/fake-network.ts fakes only the
 * network):
 *
 *   1. CSP: nonce-based script policy, no 'unsafe-inline'.
 *   2. Rate limiting: shared counters, fail closed, IP extraction.
 *   3. Paystack plans: at most one plan per product, through concurrency,
 *      crashes and Paystack outages.
 *   4. Pick alerts: queued, retried, resumed after a crash, never lost.
 *
 *   npm run test:prelaunch
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createFakeNetwork, setTestEnv } from "./fake-network";
import type { Delivery, PushOutcome, Senders } from "../src/lib/notify";
import type { SendOutcome } from "../src/lib/email";

setTestEnv();
// The real Resend client, pointed at the fake network (scripts/fake-network.ts).
process.env.RESEND_API_KEY = "re_test_unit";
process.env.EMAIL_FROM = "Tito Circle <circle@example.test>";

let net: Awaited<ReturnType<typeof createFakeNetwork>>;
const ADMIN = "00000000-0000-4000-8000-00000000000a";
const ADA = "00000000-0000-4000-8000-00000000000b";
const BOLA = "00000000-0000-4000-8000-00000000000c";
const LAPSED = "00000000-0000-4000-8000-00000000000d";

before(async () => {
  net = await createFakeNetwork();
  const q = (sql: string, params: unknown[] = []) => net.db.query(sql, params);
  await q(`insert into auth.users (id, email) values ($1,'admin@example.test'),($2,'ada@example.test'),($3,'bola@example.test'),($4,'lapsed@example.test')`, [ADMIN, ADA, BOLA, LAPSED]);
  await q(`insert into public.staff (user_id) values ($1)`, [ADMIN]);
  await q(`insert into public.entitlements (user_id, access_ends_at) values ($1, now() + interval '90 days'), ($2, now() + interval '90 days'), ($3, now() - interval '30 days')`, [ADA, BOLA, LAPSED]);
  await q(`insert into public.disclaimer_acceptances (user_id, version) values ($1,1),($2,1),($3,1)`, [ADA, BOLA, LAPSED]);
});

after(async () => {
  await net.close();
});

// ---------------------------------------------------------------------------
describe("1. Content-Security-Policy", () => {
  test("script-src is nonce + strict-dynamic, with no 'unsafe-inline'", async () => {
    const { buildCsp } = await import("../src/lib/csp");
    const csp = buildCsp("abc123", { dev: false, supabaseOrigin: "https://x.supabase.co" });
    const script = csp.split("; ").find((d) => d.startsWith("script-src "))!;
    assert.equal(script, "script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    assert.ok(!script.includes("unsafe-inline"));
    assert.ok(!script.includes("unsafe-eval"), "production must not allow eval");
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /connect-src 'self' https:\/\/x\.supabase\.co/);
  });

  test("development adds only 'unsafe-eval' (React debug stacks)", async () => {
    const { buildCsp } = await import("../src/lib/csp");
    const script = buildCsp("n", { dev: true, supabaseOrigin: "" }).split("; ").find((d) => d.startsWith("script-src "))!;
    assert.equal(script, "script-src 'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval'");
  });

  test("nonces are 128-bit and unique per call", async () => {
    const { newNonce } = await import("../src/lib/csp");
    const seen = new Set(Array.from({ length: 1000 }, newNonce));
    assert.equal(seen.size, 1000);
    for (const n of seen) assert.equal(Buffer.from(n, "base64").length, 16);
  });
});

// ---------------------------------------------------------------------------
describe("2. Rate limiting", () => {
  test("client IP on Vercel: only the edge-set header counts; client-sent headers are ignored", async () => {
    const { ipFromHeaders } = await import("../src/lib/rate-limit");
    assert.equal(ipFromHeaders(new Headers({ "x-vercel-forwarded-for": "1.1.1.1", "x-forwarded-for": "9.9.9.9" }), true), "1.1.1.1");
    assert.equal(ipFromHeaders(new Headers({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "6.6.6.6" }), true), null);
  });

  test("client IP elsewhere (local): x-real-ip, then the first x-forwarded-for hop; null if none", async () => {
    const { ipFromHeaders } = await import("../src/lib/rate-limit");
    assert.equal(ipFromHeaders(new Headers({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "9.9.9.9" }), false), "2.2.2.2");
    assert.equal(ipFromHeaders(new Headers({ "x-forwarded-for": "3.3.3.3, 10.0.0.1" }), false), "3.3.3.3");
    assert.equal(ipFromHeaders(new Headers(), false), null);
  });

  test("an unknown IP skips the IP rules instead of sharing one bucket with every visitor", async () => {
    const { signInRules } = await import("../src/lib/rate-limit");
    assert.equal(signInRules("send", null, "a@example.test").length, 1);
    assert.equal(signInRules("send", "1.2.3.4", "a@example.test").length, 3);
  });

  test("keys are hashed, case-insensitive, and never contain the raw email", async () => {
    const { keyFor } = await import("../src/lib/rate-limit");
    const k = keyFor("otp-send-email", "Ada@Example.test");
    assert.equal(k, keyFor("otp-send-email", "ada@example.test"));
    assert.ok(!k.includes("ada"));
  });

  test("one IP asking for one address: the 6th code request in 15 minutes is refused, and every rule counts", async () => {
    const { allow, signInRules } = await import("../src/lib/rate-limit");
    const rules = signInRules("send", "203.0.113.7", "target@example.test");
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await allow(rules));
    assert.deepEqual(results, [true, true, true, true, true, false]);
    // All three counters moved, even on the refused attempt.
    const hits = await net.db.query<{ hits: number }>(`select hits from public.rate_limits order by key`);
    assert.deepEqual(hits.rows.map((r) => r.hits), [6, 6, 6]);
  });

  test("an attacker hammering a member's address does not lock the member out", async () => {
    const { allow, signInRules } = await import("../src/lib/rate-limit");
    // The attacker (above) exhausted their own address+IP pair. The member,
    // from their own IP, still gets a code.
    assert.equal(await allow(signInRules("send", "198.51.100.20", "target@example.test")), true);
  });

  test("the loose per-address ceiling (30 an hour) still stops requests spread across many IPs", async () => {
    const { allow, signInRules } = await import("../src/lib/rate-limit");
    const results = [];
    for (let i = 0; i < 31; i++) results.push(await allow(signInRules("send", `192.0.2.${i}`, "spray@example.test")));
    assert.equal(results.filter(Boolean).length, 30);
    assert.equal(results[30], false);
  });

  test("fails closed: if the counter errors, the attempt is refused", async () => {
    const { allow } = await import("../src/lib/rate-limit");
    // A key over the 200-character limit makes the database reject the call.
    assert.equal(await allow([{ key: "x".repeat(300), limit: 100, windowSeconds: 60 }]), false);
  });
});

// ---------------------------------------------------------------------------
describe("3. Paystack plan creation is idempotent", () => {
  const product = async (name: string) =>
    (
      await net.db.query<{ id: string }>(
        `insert into public.products (name, price_kobo, access_months) values ($1, 30000000, 6) returning id`,
        [name],
      )
    ).rows[0].id;
  const codeOf = async (id: string) =>
    (await net.db.query<{ c: string | null }>(`select paystack_plan_code c from public.products where id = $1`, [id])).rows[0].c;

  test("a double click (two concurrent calls) creates exactly one plan", async () => {
    const { ensurePaystackPlan } = await import("../src/lib/plans");
    const id = await product("Double click");
    net.paystack.planPostDelayMs = 50;
    const before = net.paystack.planPosts;
    const [a, b] = await Promise.all([ensurePaystackPlan(id), ensurePaystackPlan(id)]);
    net.paystack.planPostDelayMs = 0;
    assert.equal(net.paystack.planPosts - before, 1, "one POST /plan");
    assert.deepEqual([a.status, b.status].sort(), ["attached", "busy"]);
    const again = await ensurePaystackPlan(id);
    assert.equal(again.status, "existing");
    assert.equal(net.paystack.planPosts - before, 1, "still one plan after a third call");
  });

  test("a crash after Paystack created the plan but before it was saved: the retry reuses it", async () => {
    const { ensurePaystackPlan } = await import("../src/lib/plans");
    const { planTag } = await import("../src/lib/paystack");
    const id = await product("Crashed save");
    // The crashed request: claimed, created the plan on Paystack, died.
    await net.db.query(`update public.products set plan_claimed_at = now() - interval '11 minutes' where id = $1`, [id]);
    net.paystack.plans.push({ plan_code: "PLN_orphan", name: `Tito Circle: Crashed save ${planTag(id)}`, amount: 30000000, interval: "biannually", createdAt: new Date().toISOString() });
    const before = net.paystack.planPosts;
    const r = await ensurePaystackPlan(id);
    assert.deepEqual(r, { status: "reused", planCode: "PLN_orphan" });
    assert.equal(net.paystack.planPosts, before, "no new plan created");
    assert.equal(await codeOf(id), "PLN_orphan");
  });

  test("a plan whose name merely CONTAINS another product's tag is not taken for it", async () => {
    const { ensurePaystackPlan } = await import("../src/lib/plans");
    const { planTag } = await import("../src/lib/paystack");
    const id = await product("Spoof target");
    net.paystack.plans.push({ plan_code: "PLN_spoof", name: `Evil ${planTag(id)} trailing`, amount: 30000000, interval: "biannually", createdAt: new Date().toISOString() });
    const r = await ensurePaystackPlan(id);
    assert.equal(r.status, "attached");
    assert.notEqual((r as { planCode: string }).planCode, "PLN_spoof");
  });

  test("a live claim from another request blocks creation until it expires", async () => {
    const { ensurePaystackPlan } = await import("../src/lib/plans");
    const id = await product("In flight");
    await net.db.query(`update public.products set plan_claimed_at = now() where id = $1`, [id]);
    assert.equal((await ensurePaystackPlan(id)).status, "busy");
  });

  test("Paystack down: the claim is released, nothing is saved, and the retry succeeds once", async () => {
    const { ensurePaystackPlan } = await import("../src/lib/plans");
    const id = await product("Outage");
    net.paystack.failNextPlanPost = true;
    const first = await ensurePaystackPlan(id);
    assert.equal(first.status, "failed");
    assert.equal(await codeOf(id), null);
    const claim = await net.db.query<{ c: string | null }>(`select plan_claimed_at c from public.products where id = $1`, [id]);
    assert.equal(claim.rows[0].c, null, "claim released for an immediate retry");
    const retry = await ensurePaystackPlan(id);
    assert.equal(retry.status, "attached");
    const tagged = net.paystack.plans.filter((p) => p.name.includes(id));
    assert.equal(tagged.length, 1, "exactly one plan for this product on Paystack");
  });
});

// ---------------------------------------------------------------------------
describe("4. Pick alerts are resumable", () => {
  let pickId = "";
  const sentEmails: string[] = [];
  const sentPush: string[] = [];
  const keys = new Map<string, number>();

  const okSenders: Senders = {
    async push(d) {
      sentPush.push(d.id);
      return { ok: true };
    },
    async email(d) {
      sentEmails.push(d.email ?? "");
      keys.set(d.id, (keys.get(d.id) ?? 0) + 1);
      return { ok: true };
    },
  };
  const statusCounts = async () =>
    Object.fromEntries(
      (await net.db.query<{ status: string; n: number }>(`select status, count(*)::int n from public.notification_deliveries group by status`)).rows.map(
        (r) => [r.status, r.n],
      ),
    );

  before(async () => {
    pickId = (
      await net.db.query<{ id: string }>(
        `insert into public.picks (ticker, market, action, entry_price, target_price, stop_price, rationale, author_id)
         values ('MTNN', 'NGX', 'buy', 200, 240, 180, 'A pick long enough to pass the check.', $1) returning id`,
        [ADMIN],
      )
    ).rows[0].id;
    await net.db.query(
      `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://fcm.googleapis.com/fcm/send/ada', 'k', 'a'), ($2, 'https://fcm.googleapis.com/fcm/send/bola', 'k', 'a')`,
      [ADA, BOLA],
    );
  });

  test("publish queues one email per member with access plus one push per device; lapsed members get nothing", async () => {
    const { enqueuePickAlerts } = await import("../src/lib/notify");
    assert.equal(await enqueuePickAlerts(pickId), 4);
    assert.equal(await enqueuePickAlerts(pickId), 0, "idempotent");
    const lapsed = await net.db.query(`select 1 from public.notification_deliveries where user_id = $1`, [LAPSED]);
    assert.equal(lapsed.rows.length, 0);
  });

  test("a worker that crashes mid-send loses nothing: the rest go out on the next run, none twice", async () => {
    const { drainAlerts } = await import("../src/lib/notify");
    // The crashed worker claimed every row, delivered (and recorded) one,
    // then died holding the other three.
    const claimed = (
      await net.db.query<Delivery>(`select * from public.claim_notification_batch(50, 300, 5)`)
    ).rows;
    assert.equal(claimed.length, 4);
    const delivered = claimed.find((d) => d.channel === "email")!;
    await net.db.query(`select public.complete_notification($1, $2, true, null, false, 5, null)`, [delivered.id, delivered.attempts]);

    // While its lock holds, nobody else may send those rows.
    const early = await drainAlerts({ senders: okSenders });
    assert.equal(early.claimed, 0);

    // The lock lapses (five minutes on; simulated), and the next run resumes.
    await net.db.query(`update public.notification_deliveries set locked_until = now() - interval '1 second' where status = 'sending'`);
    const resumed = await drainAlerts({ senders: okSenders });
    assert.equal(resumed.claimed, 3);
    assert.equal(resumed.sent, 3);
    assert.deepEqual(await statusCounts(), { sent: 4 });
    assert.ok(!sentEmails.includes(delivered.email ?? ""), "the already-delivered email was not sent again");
    assert.equal(sentPush.length, 2);

    const done = await drainAlerts({ senders: okSenders });
    assert.equal(done.claimed, 0, "nothing left");
  });

  test("a transient failure backs off and is retried with the same idempotency key; a dead device is removed", async () => {
    const { drainAlerts, enqueuePickAlerts } = await import("../src/lib/notify");
    const second = (
      await net.db.query<{ id: string }>(
        `insert into public.picks (ticker, market, action, entry_price, target_price, stop_price, rationale, author_id)
         values ('ZENITHBANK', 'NGX', 'buy', 40, 48, 36, 'Second pick, for the failure paths.', $1) returning id`,
        [ADMIN],
      )
    ).rows[0].id;
    await enqueuePickAlerts(second);

    const emailCalls: string[] = [];
    let failFirstEmail = true;
    const flaky: Senders = {
      async push(d): Promise<PushOutcome> {
        // Ada's device was unsubscribed in the browser.
        return d.endpoint!.endsWith("/ada") ? { ok: false, gone: true, error: "410" } : { ok: true };
      },
      async email(d): Promise<SendOutcome> {
        emailCalls.push(d.id);
        if (failFirstEmail && d.email === "bola@example.test") {
          failFirstEmail = false;
          return { ok: false, permanent: false, error: "rate_limit_exceeded" };
        }
        return { ok: true };
      },
    };

    const first = await drainAlerts({ senders: flaky });
    assert.equal(first.gone, 1);
    assert.equal(first.retrying, 1);
    const adaDevice = await net.db.query(`select 1 from public.push_subscriptions where endpoint like '%/ada'`);
    assert.equal(adaDevice.rows.length, 0, "dead subscription deleted");

    // Not due yet: the backoff holds it.
    assert.equal((await drainAlerts({ senders: flaky })).claimed, 0);

    await net.db.query(`update public.notification_deliveries set next_attempt_at = now() where status = 'pending'`);
    const retry = await drainAlerts({ senders: flaky });
    assert.equal(retry.sent, 1);
    const bolaRow = emailCalls.filter((id, i) => emailCalls.indexOf(id) !== i);
    assert.equal(bolaRow.length, 1, "the retried row reused its id, so its Resend idempotency key is the same");
  });

  test("a permanent failure is recorded as failed and never retried", async () => {
    const { drainAlerts, enqueuePickAlerts } = await import("../src/lib/notify");
    const third = (
      await net.db.query<{ id: string }>(
        `insert into public.picks (ticker, market, action, entry_price, target_price, stop_price, rationale, author_id)
         values ('SEPLAT', 'NGX', 'buy', 5000, 5600, 4700, 'Third pick, for the permanent failure.', $1) returning id`,
        [ADMIN],
      )
    ).rows[0].id;
    await enqueuePickAlerts(third);
    const broken: Senders = {
      async push() {
        return { ok: true };
      },
      async email() {
        return { ok: false, permanent: true, error: "validation_error: invalid to" };
      },
    };
    const r = await drainAlerts({ senders: broken });
    assert.equal(r.failed, 2);
    await net.db.query(`update public.notification_deliveries set next_attempt_at = now()`);
    assert.equal((await drainAlerts({ senders: broken })).claimed, 0);
  });

  test("a sender that throws counts as a transient failure, never as sent", async () => {
    const { drainAlerts, enqueuePickAlerts } = await import("../src/lib/notify");
    const fourth = (
      await net.db.query<{ id: string }>(
        `insert into public.picks (ticker, market, action, entry_price, target_price, stop_price, rationale, author_id)
         values ('NESTLE', 'NGX', 'hold', 900, 1000, 850, 'Fourth pick, for the throwing sender.', $1) returning id`,
        [ADMIN],
      )
    ).rows[0].id;
    await enqueuePickAlerts(fourth);
    const throwing: Senders = {
      async push() {
        throw new Error("socket hang up");
      },
      async email() {
        throw new Error("socket hang up");
      },
    };
    const r = await drainAlerts({ senders: throwing });
    assert.equal(r.sent, 0);
    assert.equal(r.retrying, r.claimed);
    const pending = await net.db.query(`select 1 from public.notification_deliveries where pick_id = $1 and status = 'pending'`, [fourth]);
    assert.equal(pending.rows.length, r.claimed);
  });

  test("a pick whose publish died before queueing is picked up by the safety net; old picks are not", async () => {
    const { enqueueUnqueuedPicks } = await import("../src/lib/notify");
    const insertPick = async (ticker: string, publishedAgo: string) =>
      (
        await net.db.query<{ id: string }>(
          `insert into public.picks (ticker, market, action, entry_price, target_price, stop_price, rationale, author_id, published_at)
           values ($1, 'NGX', 'buy', 30, 36, 27, 'Published, then the process died before queueing.', $2, now() - $3::interval) returning id`,
          [ticker, ADMIN, publishedAgo],
        )
      ).rows[0].id;
    const orphan = await insertPick("UBA", "5 minutes");
    const stale = await insertPick("FBNH", "2 days");
    // Members with access: Ada and Bola (2 emails). Devices: only Bola's
    // (Ada's was removed as dead above): 1 push.
    assert.equal(await enqueueUnqueuedPicks(), 3);
    const orphanRows = await net.db.query(`select 1 from public.notification_deliveries where pick_id = $1`, [orphan]);
    assert.equal(orphanRows.rows.length, 3);
    const staleRows = await net.db.query(`select 1 from public.notification_deliveries where pick_id = $1`, [stale]);
    assert.equal(staleRows.rows.length, 0, "a two-day-old pick is never announced as new");
    assert.equal(await enqueueUnqueuedPicks(), 0, "and only once");
  });

  test("the real email path: each row's id is its Resend idempotency key, kept across a retry", async () => {
    const { drainAlerts } = await import("../src/lib/notify");
    // Everything else due is cleared so only the UBA alerts remain. Push goes
    // through an injected sender; email through the REAL sendIdempotent and
    // Resend client, against the fake Resend API.
    const ubaEmails = (
      await net.db.query<{ id: string }>(
        `select d.id from public.notification_deliveries d join public.picks p on p.id = d.pick_id
          where p.ticker = 'UBA' and d.channel = 'email'`,
      )
    ).rows.map((r) => r.id);
    await net.db.query(
      `update public.notification_deliveries d set status = 'skipped'
        where d.status = 'pending' and d.pick_id <> (select id from public.picks where ticker = 'UBA')`,
    );
    const pushOk: Senders["push"] = async () => ({ ok: true });

    net.resend.failNext.push({ status: 429, name: "rate_limit_exceeded" });
    const first = await drainAlerts({ senders: { push: pushOk } });
    assert.equal(first.retrying, 1, "one email hit Resend's rate limit and will retry");
    assert.equal(net.resend.sent.length, 1);

    await net.db.query(`update public.notification_deliveries set next_attempt_at = now() where status = 'pending'`);
    const second = await drainAlerts({ senders: { push: pushOk } });
    assert.equal(second.sent, 1);

    const keys = net.resend.sent.map((m) => m.idempotencyKey).sort();
    assert.deepEqual(keys, ubaEmails.map((id) => `pick-alert-${id}`).sort(), "one accepted email per row, keyed by row id");
  });

  test("a Resend daily-quota error waits six hours instead of giving up", async () => {
    const { drainAlerts } = await import("../src/lib/notify");
    const pick = (
      await net.db.query<{ id: string }>(
        `insert into public.picks (ticker, market, action, entry_price, target_price, stop_price, rationale, author_id)
         values ('ACCESSCORP', 'NGX', 'buy', 20, 24, 18, 'Quota day: alerts must still go out tomorrow.', $1) returning id`,
        [ADMIN],
      )
    ).rows[0].id;
    const { enqueuePickAlerts } = await import("../src/lib/notify");
    await enqueuePickAlerts(pick);
    net.resend.failNext.push({ status: 429, name: "daily_quota_exceeded" }, { status: 429, name: "daily_quota_exceeded" });
    const r = await drainAlerts({ senders: { push: async () => ({ ok: true }) } });
    assert.equal(r.failed, 0);
    const waits = await net.db.query<{ ok: boolean }>(
      `select next_attempt_at > now() + interval '5 hours 59 minutes' ok from public.notification_deliveries
        where pick_id = $1 and channel = 'email'`,
      [pick],
    );
    assert.ok(waits.rows.length === 2 && waits.rows.every((w) => w.ok));
  });
});

// ---------------------------------------------------------------------------
describe("5. Proxy: nonce wiring", () => {
  test("every page response carries a fresh nonce CSP, and Next.js receives the same policy and nonce", async () => {
    const { proxy } = await import("../src/proxy");
    const { NextRequest } = await import("next/server");
    const a = await proxy(new NextRequest("http://localhost/sign-in"));
    const b = await proxy(new NextRequest("http://localhost/sign-in"));
    const csp = a.headers.get("content-security-policy")!;
    const nonce = csp.match(/'nonce-([^']+)'/)![1];
    assert.match(csp, /script-src 'self' 'nonce-[^']+' 'strict-dynamic'(;|$)/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
    // What the page render sees (request-header overrides).
    assert.equal(a.headers.get("x-middleware-request-content-security-policy"), csp);
    assert.equal(a.headers.get("x-middleware-request-x-nonce"), nonce);
    assert.notEqual(b.headers.get("content-security-policy"), csp, "a new nonce per request");
  });

  test("the sign-in redirect also carries the CSP", async () => {
    const { proxy } = await import("../src/proxy");
    const { NextRequest } = await import("next/server");
    const r = await proxy(new NextRequest("http://localhost/picks"));
    assert.equal(r.status, 307);
    assert.match(r.headers.get("location")!, /\/sign-in$/);
    assert.match(r.headers.get("content-security-policy")!, /'nonce-/);
  });

  test("API routes (webhook, cron) bypass the proxy; pages do not", async () => {
    const { config } = await import("../src/proxy");
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const p of ["/api/cron/alerts", "/api/paystack/webhook", "/sw.js", "/_next/static/x.js"]) assert.ok(!matcher.test(p), p);
    for (const p of ["/", "/sign-in", "/picks", "/admin/products"]) assert.ok(matcher.test(p), p);
  });
});
