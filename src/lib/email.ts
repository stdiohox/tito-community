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

/** Sends to many, 100 per Resend batch call. Returns how many were accepted. */
export async function sendBatch(mails: Mail[]): Promise<number> {
  const r = resend();
  if (!r) {
    console.warn(`[email] not configured; skipped ${mails.length} emails`);
    return 0;
  }
  let sent = 0;
  for (let i = 0; i < mails.length; i += 100) {
    const chunk = mails.slice(i, i + 100).map((m) => ({ from: env.emailFrom()!, ...m }));
    const { error } = await r.batch.send(chunk);
    if (error) {
      console.error(`[email] batch ${i / 100 + 1} failed: ${error.message}`);
    } else {
      sent += chunk.length;
    }
  }
  return sent;
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
