/**
 * Seeds a demo Tito Circle: one admin, three members (active, expiring in two
 * days, expired), two products, and clearly labelled sample content.
 *
 *   npm run seed
 *
 * Reads .env.local. SEED_EMAIL is your own inbox: the admin signs in as it,
 * and the members use plus-addresses of it, so every sign-in code lands with
 * you. With SEED_EMAIL=you@gmail.com:
 *
 *   admin     you@gmail.com
 *   active    you+active@gmail.com      access for 120 more days
 *   expiring  you+expiring@gmail.com    access ends in 2 days
 *   expired   you+expired@gmail.com     ended 10 days ago (past the grace period)
 *
 * Safe to run more than once: users, staff, products and sample content are
 * only created when missing, and the three members' end dates are reset to
 * the values above on every run (so "expiring in 2 days" stays true).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describePlanOutcome, ensurePaystackPlan } from "../src/lib/plans";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set. Add it to .env.local (see README).`);
    process.exit(1);
  }
  return v;
}

const url = need("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = need("SUPABASE_SERVICE_ROLE_KEY");
const seedEmail = need("SEED_EMAIL").trim().toLowerCase();
const [local, domain] = seedEmail.split("@");
if (!local || !domain) {
  console.error("SEED_EMAIL must be a full email address.");
  process.exit(1);
}
const plus = (tag: string) => `${local.split("+")[0]}+${tag}@${domain}`;

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const DAY = 86_400_000;

async function ensureUser(email: string, fullName: string): Promise<string> {
  const { data: existing } = await db.from("profiles").select("user_id").eq("email", email).maybeSingle();
  if (existing) return existing.user_id;
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
  await db.from("profiles").update({ full_name: fullName }).eq("user_id", data.user.id);
  return data.user.id;
}

async function setAccess(userId: string, endsAt: Date) {
  const { error } = await db
    .from("entitlements")
    .upsert({ user_id: userId, access_ends_at: endsAt.toISOString(), status: "active", status_reason: null, updated_at: new Date().toISOString() });
  if (error) throw new Error(`entitlement: ${error.message}`);
}

async function seedProducts(adminId: string) {
  const { count } = await db.from("products").select("id", { count: "exact", head: true });
  if ((count ?? 0) === 0) {
    // Demo prices. The 6-month price matches Close Community in the CRM
    // catalogue; the 1-month price is a placeholder for Tito to set.
    const { error } = await db.from("products").insert([
      { name: "Circle · 1 month", description: "A month of picks, updates and notices.", price_kobo: 6_000_000, access_months: 1, created_by: adminId },
      { name: "Circle · 6 months", description: "Six months in the Circle. Best value.", price_kobo: 30_000_000, access_months: 6, created_by: adminId },
    ]);
    if (error) throw new Error(`products: ${error.message}`);
  }

  // Auto-renew plans, through the same idempotent path the admin uses: safe
  // to re-run, and it picks up products seeded before Paystack was set up.
  const { data: products, error } = await db.from("products").select("id, name").order("price_kobo");
  if (error) throw new Error(`products: ${error.message}`);
  for (const p of products) {
    const outcome = await ensurePaystackPlan(p.id);
    console.log(`product: ${p.name} (${describePlanOutcome(outcome)})`);
  }
}

async function seedContent(db: SupabaseClient, adminId: string) {
  const { count } = await db.from("picks").select("id", { count: "exact", head: true });
  if ((count ?? 0) > 0) {
    console.log("sample content: picks already present, left alone");
    return;
  }
  const now = Date.now();
  const sample = "SAMPLE PICK FOR THE DEMO. Not a recommendation and not real analysis.";
  const picks = [
    {
      ticker: "DANGCEM",
      market: "NGX",
      action: "buy",
      entry_price: 480,
      target_price: 560,
      stop_price: 440,
      rationale: `${sample}\n\nShows how a buy reads: the thesis, what would invalidate it, and the levels Tito is watching.`,
      author_holds: true,
      published_at: new Date(now - 2 * DAY).toISOString(),
    },
    {
      ticker: "GTCO",
      market: "NGX",
      action: "buy",
      entry_price: 52,
      target_price: 61,
      stop_price: 47.5,
      rationale: `${sample}\n\nA second card so the feed has rhythm. Open it to see an update thread.`,
      author_holds: false,
      published_at: new Date(now - 6 * 3600_000).toISOString(),
    },
  ];
  const { data, error } = await db
    .from("picks")
    .insert(picks.map((p) => ({ ...p, author_id: adminId, notified_at: new Date().toISOString() })))
    .select("id, ticker");
  if (error) throw new Error(`picks: ${error.message}`);
  const gtco = data.find((p) => p.ticker === "GTCO")!;
  await db.from("pick_updates").insert({
    pick_id: gtco.id,
    kind: "note",
    body: "SAMPLE UPDATE. Holding steady; levels unchanged.",
    author_id: adminId,
  });
  await db.from("announcements").insert({
    title: "Welcome to Tito Circle (demo)",
    body: "This is a sample notice. Tito uses notices for live-session dates, housekeeping and anything that isn't a pick.",
    pinned: true,
    author_id: adminId,
  });
  console.log("sample content: 2 picks, 1 update, 1 notice");
}

async function main() {
  console.log(`Seeding ${url}\n`);

  const adminId = await ensureUser(seedEmail, "Tito (admin)");
  // Opens the admin's authenticator enrolment window, once: only when the
  // staff row is first created. Re-running the seed never reopens it.
  await db.from("staff").upsert({ user_id: adminId, role: "admin", mfa_enrollment_open: true }, { onConflict: "user_id", ignoreDuplicates: true });
  console.log(`admin:    ${seedEmail}`);

  const members: [string, string, Date][] = [
    ["active", "Ada (active)", new Date(Date.now() + 120 * DAY)],
    ["expiring", "Bola (expiring)", new Date(Date.now() + 2 * DAY)],
    ["expired", "Chidi (expired)", new Date(Date.now() - 10 * DAY)],
  ];
  for (const [tag, name, ends] of members) {
    const email = plus(tag);
    const id = await ensureUser(email, name);
    await setAccess(id, ends);
    console.log(`${tag.padEnd(9)} ${email}  access to ${ends.toISOString().slice(0, 10)}`);
  }
  console.log("");

  await seedProducts(adminId);
  await seedContent(db, adminId);

  console.log("\nDone. Sign in at /sign-in with any of the addresses above.");
  console.log("The admin is asked to set up an authenticator app on first visit to /admin.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
