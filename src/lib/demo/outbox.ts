import "server-only";
import { currentVisitor, exec } from "@/lib/demo/db";

/**
 * Where email goes in demo mode: the visitor's private outbox (viewable at
 * /demo/outbox), never Resend, never a real inbox.
 */
export async function recordDemoEmail(mail: { to: string; subject: string; text: string }): Promise<boolean> {
  try {
    const v = await currentVisitor();
    await exec(v, `insert into public.demo_outbox (to_email, subject, body) values ($1, $2, $3)`, [mail.to, mail.subject, mail.text], {
      claims: null,
      role: null,
      persist: true,
    });
    return true;
  } catch (e) {
    // Reported as not sent, so an alert is retried rather than marked delivered.
    console.warn(`[demo] outbox entry not recorded: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}
