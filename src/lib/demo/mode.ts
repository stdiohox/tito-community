/**
 * Client preview mode: the whole app on sample data, with no Supabase,
 * Paystack, Resend or push service behind it.
 *
 * SAFETY. Demo mode is on only when DEMO_MODE=true AND none of the real
 * service keys are present. If DEMO_MODE=true is set alongside any real key,
 * this throws on every request (and at boot, from instrumentation.ts), so a
 * deployment can never half-run as a demo on top of real data, and a real
 * deployment can never be flipped into a demo by one stray variable.
 *
 * In demo mode every outbound call (database, auth, storage, payments) is
 * routed to an in-process fake (src/lib/demo/fetch.ts) that refuses any
 * other host, and email is written to an in-memory outbox instead of sent.
 *
 * No "server-only" import: the proxy and instrumentation read this too.
 */

/** Any one of these present means real services are configured. */
export const REAL_SERVICE_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PAYSTACK_SECRET_KEY",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "ADMIN_ALERT_EMAILS",
  "VAPID_PRIVATE_KEY",
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  "CRON_SECRET",
  "DATABASE_URL",
  "SUPABASE_DB_URL",
] as const;

export class DemoModeRefused extends Error {
  constructor(present: string[]) {
    super(
      `DEMO_MODE=true is refused because real service keys are set (${present.join(", ")}). ` +
        "Demo mode must never run against real services. Remove DEMO_MODE, or deploy the demo as its own project without these keys.",
    );
    this.name = "DemoModeRefused";
  }
}

export function isDemo(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DEMO_MODE !== "true") return false;
  const present = REAL_SERVICE_KEYS.filter((k) => Boolean(env[k]));
  if (present.length > 0) throw new DemoModeRefused(present);
  return true;
}

/**
 * Signs demo sessions and the per-visitor state cookie. Required in a
 * production demo deployment; a fixed development value otherwise.
 */
export function demoSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.DEMO_SECRET;
  if (s && s.length >= 32) return s;
  if (env.NODE_ENV === "production") {
    throw new Error("DEMO_SECRET (32+ random characters) must be set for a production demo deployment.");
  }
  return "local-development-demo-secret-not-for-production";
}

/** The site's own origin. Demo "Supabase" lives under it so chart links stay same-origin. */
export function demoSiteUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:3000";
}

export function demoSupabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${demoSiteUrl(env)}/demo-supabase`;
}

export const DEMO_COOKIES = {
  /** Identifies a visitor's private copy of the sample data. */
  sid: "tc_demo_sid",
  /** Signed, compressed log of the visitor's changes, in numbered chunks. */
  log: "tc_demo_log",
} as const;
