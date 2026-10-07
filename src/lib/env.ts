import "server-only";

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

export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  siteUrl: () => required("NEXT_PUBLIC_SITE_URL").replace(/\/$/, ""),

  paystackSecretKey: () => optional("PAYSTACK_SECRET_KEY"),

  resendApiKey: () => optional("RESEND_API_KEY"),
  emailFrom: () => optional("EMAIL_FROM"),
  adminAlertEmails: () =>
    (optional("ADMIN_ALERT_EMAILS") ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),

  vapidPublicKey: () => optional("NEXT_PUBLIC_VAPID_PUBLIC_KEY"),
  vapidPrivateKey: () => optional("VAPID_PRIVATE_KEY"),
  vapidSubject: () => optional("VAPID_SUBJECT"),
};
