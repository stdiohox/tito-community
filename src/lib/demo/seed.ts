/**
 * Sample data for client preview mode. Loaded into an in-process Postgres
 * (PGlite) on top of the REAL migrations, so every screen runs the real
 * queries and the real RLS. All dates are relative to "now", so "expiring
 * in two days" stays true whenever the demo is opened.
 *
 * Everything here is fictional: the people, emails and calls are invented
 * for the demo, and every page says so.
 */

export const DEMO_USERS = {
  admin: { id: "d0000000-0000-4000-8000-000000000001", email: "tito@titocircle.example", name: "Tito Oreolorun" },
  active: { id: "d0000000-0000-4000-8000-000000000002", email: "ada.okafor@example.com", name: "Ada Okafor" },
  expiring: { id: "d0000000-0000-4000-8000-000000000003", email: "bola.adeyemi@example.com", name: "Bola Adeyemi" },
  expired: { id: "d0000000-0000-4000-8000-000000000004", email: "chidi.eze@example.com", name: "Chidi Eze" },
} as const;

export type Persona = keyof typeof DEMO_USERS | "signedout";

/** The staff user's (already verified) authenticator, for the demo MFA screen. */
export const DEMO_ADMIN_FACTOR_ID = "d0000000-0000-4000-8000-0000000000fa";

const OTHERS = [
  { id: "d0000000-0000-4000-8000-000000000005", email: "ngozi.obi@example.co.uk", name: "Ngozi Obi", ends: "interval '160 days'", customer: null },
  { id: "d0000000-0000-4000-8000-000000000006", email: "emeka.nwosu@example.com", name: "Emeka Nwosu", ends: "interval '95 days'", customer: "CUS_demo_emeka" },
  { id: "d0000000-0000-4000-8000-000000000007", email: "funmi.bello@example.com", name: "Funmi Bello", ends: "interval '40 days'", customer: null },
  { id: "d0000000-0000-4000-8000-000000000008", email: "kelechi.okeke@example.com", name: "Kelechi Okeke", ends: "- interval '45 days'", customer: null },
  { id: "d0000000-0000-4000-8000-000000000009", email: "tunde.bakare@example.com", name: "Tunde Bakare", ends: null, customer: null },
];

const PRODUCT = {
  m1: "d1000000-0000-4000-8000-000000000001",
  m3: "d1000000-0000-4000-8000-000000000003",
  m6: "d1000000-0000-4000-8000-000000000006",
};

const PICK = {
  dangcem: "d2000000-0000-4000-8000-000000000001",
  gtco: "d2000000-0000-4000-8000-000000000002",
  mtnn: "d2000000-0000-4000-8000-000000000003",
  seplat: "d2000000-0000-4000-8000-000000000004",
  aapl: "d2000000-0000-4000-8000-000000000005",
  zenith: "d2000000-0000-4000-8000-000000000006",
  nestle: "d2000000-0000-4000-8000-000000000007",
};

const chart = (pick: string) => `${DEMO_USERS.admin.id}/${pick}.png`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Tables that exist only in the demo: the simulated Paystack and the email outbox. */
export const DEMO_SCHEMA = `
create table public.demo_paystack_transactions (
  reference     text primary key,
  email         text not null,
  amount_kobo   bigint not null,
  plan_code     text,
  callback_url  text,
  status        text not null default 'pending',
  customer_code text,
  paid_at       timestamptz,
  created_at    timestamptz not null default now()
);
create table public.demo_paystack_plans (
  plan_code   text primary key,
  name        text not null,
  amount_kobo bigint not null,
  interval    text not null,
  created_at  timestamptz not null default now()
);
create table public.demo_outbox (
  id        bigint generated always as identity primary key,
  to_email  text not null,
  subject   text not null,
  body      text not null,
  sent_at   timestamptz not null default now()
);
`;

export function demoSeedSql(): string {
  const { admin, active, expiring, expired } = DEMO_USERS;
  const all = [admin, active, expiring, expired, ...OTHERS];
  const adminClaims = JSON.stringify({ sub: admin.id, role: "authenticated", aal: "aal2" });

  return `
-- People
insert into auth.users (id, email) values
  ${all.map((u) => `(${q(u.id)}, ${q(u.email)})`).join(",\n  ")};
${all.map((u) => `update public.profiles set full_name = ${q(u.name)} where user_id = ${q(u.id)};`).join("\n")}
update public.profiles set paystack_customer_code = 'CUS_demo_emeka' where user_id = ${q(OTHERS[1].id)};
insert into public.staff (user_id, role, mfa_enrollment_open) values (${q(admin.id)}, 'admin', false);

-- Access
insert into public.entitlements (user_id, access_ends_at, status, status_reason) values
  (${q(active.id)},   now() + interval '120 days', 'active', null),
  (${q(expiring.id)}, now() + interval '2 days',   'active', null),
  (${q(expired.id)},  now() - interval '10 days',  'active', null),
  ${OTHERS.filter((o) => o.ends)
    .map((o) => `(${q(o.id)}, now() ${o.ends!.startsWith("-") ? o.ends : `+ ${o.ends}`}, ${o.id === OTHERS[2].id ? "'revoked', 'Shared login reported'" : "'active', null"})`)
    .join(",\n  ")};

-- The active-member persona has NOT accepted the disclaimer yet, so the
-- demo shows that step. Everyone else has.
insert into public.disclaimer_acceptances (user_id, version) values
  ${all.filter((u) => u.id !== active.id && u.id !== OTHERS[4].id).map((u) => `(${q(u.id)}, 1)`).join(", ")};

-- Products (prices: 6 months matches Close Community; the others are placeholders)
insert into public.products (id, name, description, price_kobo, access_months, paystack_plan_code, created_by, created_at) values
  (${q(PRODUCT.m1)}, 'Circle · 1 month', 'A month of picks, updates and live-session notices.', 6000000, 1, 'PLN_demo_1m', ${q(admin.id)}, now() - interval '90 days'),
  (${q(PRODUCT.m3)}, 'Circle · 3 months', 'A quarter in the Circle.', 16500000, 3, 'PLN_demo_3m', ${q(admin.id)}, now() - interval '90 days'),
  (${q(PRODUCT.m6)}, 'Circle · 6 months', 'Six months in the Circle. Best value.', 30000000, 6, 'PLN_demo_6m', ${q(admin.id)}, now() - interval '90 days');
insert into public.demo_paystack_plans (plan_code, name, amount_kobo, interval) values
  ('PLN_demo_1m', 'Tito Circle: Circle · 1 month [tc:${PRODUCT.m1}]', 6000000, 'monthly'),
  ('PLN_demo_3m', 'Tito Circle: Circle · 3 months [tc:${PRODUCT.m3}]', 16500000, 'quarterly'),
  ('PLN_demo_6m', 'Tito Circle: Circle · 6 months [tc:${PRODUCT.m6}]', 30000000, 'biannually');

-- Payment history
insert into public.payments (reference, user_id, product_id, kind, amount_kobo, currency, paid_at, term_starts_at, term_ends_at) values
  ('T_demo_ada_1', ${q(active.id)}, ${q(PRODUCT.m6)}, 'one_off', 30000000, 'NGN', now() - interval '62 days', now() - interval '62 days', now() + interval '120 days'),
  ('T_demo_bola_1', ${q(expiring.id)}, ${q(PRODUCT.m1)}, 'one_off', 6000000, 'NGN', now() - interval '28 days', now() - interval '28 days', now() + interval '2 days'),
  ('T_demo_chidi_1', ${q(expired.id)}, ${q(PRODUCT.m6)}, 'one_off', 30000000, 'NGN', now() - interval '192 days', now() - interval '192 days', now() - interval '10 days'),
  ('T_demo_emeka_1', ${q(OTHERS[1].id)}, ${q(PRODUCT.m3)}, 'subscription', 16500000, 'NGN', now() - interval '85 days', now() - interval '85 days', now() + interval '95 days');
insert into public.subscriptions (subscription_code, user_id, product_id, status, next_payment_date) values
  ('SUB_demo_emeka', ${q(OTHERS[1].id)}, ${q(PRODUCT.m3)}, 'active', now() + interval '95 days');

-- Picks, posted as Tito so the audit log names him.
select set_config('request.jwt.claims', ${q(adminClaims)}, false);
select set_config('request.jwt.claim.sub', ${q(admin.id)}, false);

insert into public.picks (id, ticker, market, action, entry_price, target_price, stop_price, rationale, author_holds, chart_path, author_id, published_at, notified_at) values
  (${q(PICK.nestle)}, 'NESTLE', 'NGX', 'sell', 1050, 920, 1110,
   ${q("Margins remain under pressure from input costs and the FX translation hit, and the recent rally priced in a recovery the numbers do not yet show. Taking the other side into strength.\n\nWhat would change my mind: a clean quarter with gross margin back above 30%.")},
   false, null, ${q(admin.id)}, now() - interval '38 days', now() - interval '38 days'),
  (${q(PICK.dangcem)}, 'DANGCEM', 'NGX', 'buy', 470, 560, 430,
   ${q("Pricing power is intact, export volumes are growing and the dividend is well covered. The recent pullback gives a better entry than we have had all year.\n\nThe risk is energy cost: if gas supply tightens again, margins compress. The stop sits under the last consolidation range.")},
   true, ${q(chart(PICK.dangcem))}, ${q(admin.id)}, now() - interval '21 days', now() - interval '21 days'),
  (${q(PICK.gtco)}, 'GTCO', 'NGX', 'buy', 58, 68, 53,
   ${q("Best-in-class return on equity, a conservative loan book and a growing payments business. Trading below its five-year average multiple despite stronger earnings.\n\nWatch the recapitalisation timeline: a large rights issue at a discount would weigh on the price short term.")},
   false, ${q(chart(PICK.gtco))}, ${q(admin.id)}, now() - interval '10 days', now() - interval '10 days'),
  (${q(PICK.mtnn)}, 'MTNN', 'NGX', 'hold', 255, 290, 230,
   ${q("Tariff adjustments are flowing through, but the balance sheet still carries the FX losses. Not adding here; holders can sit tight while data revenue does the work.\n\nAn upgrade to buy needs two quarters of positive retained earnings.")},
   false, null, ${q(admin.id)}, now() - interval '6 days', now() - interval '6 days'),
  (${q(PICK.seplat)}, 'SEPLAT', 'NGX', 'buy', 5400, 6200, 5000,
   ${q("The onshore-to-offshore transition is largely done and production guidance has been raised. Dollar earnings make it one of the few NGX names that benefits from a weaker naira.\n\nOil price is the obvious risk; the stop protects against a sharp move in Brent.")},
   true, ${q(chart(PICK.seplat))}, ${q(admin.id)}, now() - interval '3 days', now() - interval '3 days'),
  (${q(PICK.aapl)}, 'AAPL', 'US', 'trim', 228.4, 205, 241,
   ${q("For diaspora members holding US shares: the position has run well ahead of earnings growth. Trim a third, keep the core, and let the rest ride with a stop above the recent high.")},
   false, null, ${q(admin.id)}, now() - interval '2 days', now() - interval '2 days'),
  (${q(PICK.zenith)}, 'ZENITHBANK', 'NGX', 'buy', 42, 49, 38.5,
   ${q("High dividend yield, strong capital buffers and a valuation that already assumes the worst on FX. A patient entry for income-focused members.\n\nSize it as an income position, not a trade.")},
   false, ${q(chart(PICK.zenith))}, ${q(admin.id)}, now() - interval '5 hours', now() - interval '5 hours');

insert into public.pick_updates (pick_id, kind, body, author_id, published_at) values
  (${q(PICK.nestle)}, 'target_hit', 'Target reached at ₦920 after the half-year results.', ${q(admin.id)}, now() - interval '12 days'),
  (${q(PICK.nestle)}, 'closed', 'Closed. Thank you to everyone who followed this one with discipline.', ${q(admin.id)}, now() - interval '12 days' + interval '1 hour'),
  (${q(PICK.dangcem)}, 'note', 'Q3 numbers came in ahead of expectations. Holding; nothing to do.', ${q(admin.id)}, now() - interval '14 days'),
  (${q(PICK.dangcem)}, 'revised', 'Moved the stop up to ₦480 to protect gains. Target unchanged.', ${q(admin.id)}, now() - interval '4 days'),
  (${q(PICK.gtco)}, 'note', 'Rights issue terms announced: smaller discount than feared. Thesis intact.', ${q(admin.id)}, now() - interval '2 days');

insert into public.announcements (title, body, pinned, author_id, published_at) values
  ('Welcome to Tito Circle', ${q("Every pick comes with an entry, a target and a stop. When something changes, I post an update under the pick, so you always know where we stand.\n\nNothing here is personal advice: size positions for your own situation.")}, true, ${q(admin.id)}, now() - interval '60 days'),
  ('Live session: Thursday, 7pm WAT', ${q("Members-only Q&A on position sizing and when to take profits. The link goes out an hour before.")}, false, ${q(admin.id)}, now() - interval '1 day'),
  ('Public holiday trading', ${q("The NGX is closed on Wednesday. Orders placed that day will execute on Thursday's open.")}, false, ${q(admin.id)}, now() - interval '9 days');

select set_config('request.jwt.claims', '', false);
select set_config('request.jwt.claim.sub', '', false);

-- Charts for the picks that have one.
insert into storage.objects (bucket_id, name) values
  ${[PICK.dangcem, PICK.gtco, PICK.seplat, PICK.zenith].map((p) => `('charts', ${q(chart(p))})`).join(", ")};
`;
}
