import "server-only";
import { Resend } from "resend";
import { env } from "@/lib/env";

type Mail = { to: string; subject: string; text: string; html: string };

let client: Resend | null = null;

function resend(): Resend | null {
  const key = env.resendApiKey();
  if (!key || !env.emailFrom()) return null;
  client ??= new Resend(key);
  return client;
}

export function emailConfigured(): boolean {
  return resend() !== null;
}

/** Sends one email. Returns false (and logs why) when email is not configured. */
export async function sendEmail(mail: Mail): Promise<boolean> {
  const r = resend();
  if (!r) {
    console.warn(`[email] RESEND_API_KEY or EMAIL_FROM not set; not sending "${mail.subject}"`);
    return false;
  }
  const { error } = await r.emails.send({ from: env.emailFrom()!, ...mail });
  if (error) {
    console.error(`[email] "${mail.subject}" to one recipient failed: ${error.message}`);
    return false;
  }
  return true;
}

export type SendOutcome =
  | { ok: true }
  | { ok: false; permanent: boolean; error: string; retryAfterSeconds?: number };

// Resend error codes worth retrying soon (normal backoff).
const RETRYABLE = new Set(["rate_limit_exceeded", "internal_server_error", "application_error", "concurrent_idempotent_requests"]);
// Quota errors clear on their own, just not soon: retry after a long wait
// rather than give up, so a launch-day pick beyond the plan's daily quota
// still reaches everyone.
const QUOTA_WAIT_SECONDS: Record<string, number> = {
  daily_quota_exceeded: 6 * 3600,
  monthly_quota_exceeded: 24 * 3600,
};
const SEND_TIMEOUT_MS = 15_000;

/**
 * One email with an idempotency key. Resend sends at most one email per key,
 * so a retry after a crash or a timeout (same key) can never deliver a
 * duplicate. Times out rather than hang a whole batch.
 */
export async function sendIdempotent(mail: Mail, idempotencyKey: string): Promise<SendOutcome> {
  const r = resend();
  if (!r) return { ok: false, permanent: true, error: "Email is not configured (RESEND_API_KEY / EMAIL_FROM)" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Resend did not answer within ${SEND_TIMEOUT_MS / 1000}s`)), SEND_TIMEOUT_MS);
    });
    const { error } = await Promise.race([r.emails.send({ from: env.emailFrom()!, ...mail }, { idempotencyKey }), timeout]);
    if (!error) return { ok: true };
    const wait = QUOTA_WAIT_SECONDS[error.name];
    if (wait) return { ok: false, permanent: false, error: `${error.name}: ${error.message}`, retryAfterSeconds: wait };
    return { ok: false, permanent: !RETRYABLE.has(error.name), error: `${error.name}: ${error.message}` };
  } catch (e) {
    // Network failure or timeout: worth retrying (the key prevents a double).
    return { ok: false, permanent: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** One branded, minimal layout. Plain text is always sent alongside. */
export function layout(heading: string, paragraphs: string[], cta?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px;line-height:1.6">${escape(p)}</p>`).join("");
  const button = cta
    ? `<p style="margin:24px 0"><a href="${escape(cta.url)}" style="background:#1A3A16;color:#F8F5EE;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600;display:inline-block">${escape(cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#F8F5EE;font-family:Helvetica,Arial,sans-serif;color:#0D0B08">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="font-family:Georgia,serif;font-size:22px;color:#1A3A16;margin:0 0 24px">Tito <span style="color:#C9A84C">Circle</span></p>
<h1 style="font-family:Georgia,serif;font-weight:normal;font-size:26px;margin:0 0 16px">${escape(heading)}</h1>
${body}${button}
<p style="margin:32px 0 0;font-size:12px;color:#5B564C">You are receiving this because you are a member of Tito Circle.</p>
</div></body></html>`;
}
