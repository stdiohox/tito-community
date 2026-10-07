import "server-only";
import { demoSiteUrl, demoSupabaseUrl, isDemo } from "@/lib/demo/mode";
import { demoAnonKey, demoPaystackKey, demoServiceKey } from "@/lib/demo/token";
import { DEMO_USERS } from "@/lib/demo/seed";

/**
 * Server environment, read lazily so `next build` does not need secrets.
 *
 * Required values throw a clear error the first time they are used. Optional
 * integrations (Paystack, Resend, web push) report themselves as unconfigured
 * instead, and the feature that needs them says so on screen and in the log.
 * Nothing silently pretends to work.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. See README.md, "Environment variables".`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

const real = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  siteUrl: () => required("NEXT_PUBLIC_SITE_URL").replace(/\/$/, ""),

  paystackSecretKey: (): string | undefined => optional("PAYSTACK_SECRET_KEY"),

  resendApiKey: (): string | undefined => optional("RESEND_API_KEY"),
  emailFrom: (): string | undefined => optional("EMAIL_FROM"),
  adminAlertEmails: () =>
    (optional("ADMIN_ALERT_EMAILS") ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),

  vapidPublicKey: (): string | undefined => optional("NEXT_PUBLIC_VAPID_PUBLIC_KEY"),
  vapidPrivateKey: (): string | undefined => optional("VAPID_PRIVATE_KEY"),
  vapidSubject: (): string | undefined => optional("VAPID_SUBJECT"),
};

/**
 * Client preview mode (src/lib/demo/mode.ts): every service value points at
 * the in-process demo instead. isDemo() throws if real keys are set
 * alongside DEMO_MODE, so demo and real values can never mix.
 */
const demo: typeof real = {
  supabaseUrl: () => demoSupabaseUrl(),
  supabaseAnonKey: () => demoAnonKey(),
  supabaseServiceRoleKey: () => demoServiceKey(),
  siteUrl: () => demoSiteUrl(),
  // Only ever used with the Paystack simulator (and to sign its events).
  paystackSecretKey: () => demoPaystackKey(),
  // Email is intercepted before any provider and lands in the demo outbox.
  resendApiKey: () => "re_demo_outbox",
  emailFrom: () => "Tito Circle <circle@titocircle.example>",
  adminAlertEmails: () => [DEMO_USERS.admin.email],
  vapidPublicKey: () => undefined,
  vapidPrivateKey: () => undefined,
  vapidSubject: () => undefined,
};

export const env: typeof real = Object.fromEntries(
  Object.keys(real).map((k) => [k, () => (isDemo() ? demo : real)[k as keyof typeof real]()]),
) as typeof real;
