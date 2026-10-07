import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Fixed-window rate limits, counted in Postgres (rate_limit_hit) so every
 * serverless instance shares one count. Supabase has its own OTP limits;
 * these sit in front of them and also cover TOTP.
 *
 * Shaped so that an attacker who knows a member's email cannot cheaply lock
 * that member out: the tight per-email limits are per email AND IP (the
 * attacker exhausts only their own pair), and the per-email-only ceiling is
 * hourly and loose, there to stop distributed guessing, not to throttle use.
 */
export const LIMITS = {
  otpSendPerIp: { limit: 10, windowSeconds: 900 },
  otpSendPerEmailIp: { limit: 5, windowSeconds: 900 },
  otpSendPerEmail: { limit: 30, windowSeconds: 3600 },
  otpVerifyPerIp: { limit: 30, windowSeconds: 900 },
  otpVerifyPerEmailIp: { limit: 10, windowSeconds: 900 },
  otpVerifyPerEmail: { limit: 50, windowSeconds: 3600 },
  totpVerifyPerUser: { limit: 10, windowSeconds: 900 },
} as const;

export type Rule = { key: string; limit: number; windowSeconds: number };

/**
 * Client IP, or null if it cannot be trusted.
 *
 * On Vercel only x-vercel-forwarded-for is read: the edge sets it and a
 * client cannot forge it. Anywhere else (local development) the usual proxy
 * headers are read instead. Null means "unknown": the IP-based rules are
 * then skipped rather than putting every visitor in one shared bucket.
 */
export function ipFromHeaders(h: Headers, onVercel = process.env.VERCEL === "1"): string | null {
  const first = (v: string | null) => v?.split(",")[0]?.trim() || null;
  if (onVercel) return first(h.get("x-vercel-forwarded-for"));
  return first(h.get("x-real-ip")) ?? first(h.get("x-forwarded-for"));
}

export async function clientIp(): Promise<string | null> {
  return ipFromHeaders(await headers());
}

/** The rules for sending a sign-in code, or for checking one. */
export function signInRules(kind: "send" | "verify", ip: string | null, email: string): Rule[] {
  const L =
    kind === "send"
      ? { ip: LIMITS.otpSendPerIp, pair: LIMITS.otpSendPerEmailIp, email: LIMITS.otpSendPerEmail }
      : { ip: LIMITS.otpVerifyPerIp, pair: LIMITS.otpVerifyPerEmailIp, email: LIMITS.otpVerifyPerEmail };
  const rules: Rule[] = [{ key: keyFor(`otp-${kind}-email`, email), ...L.email }];
  if (ip) {
    rules.push({ key: keyFor(`otp-${kind}-ip`, ip), ...L.ip });
    rules.push({ key: keyFor(`otp-${kind}-pair`, `${email}|${ip}`), ...L.pair });
  }
  return rules;
}

/** Keys never carry raw emails or IPs: they are hashed first. */
export function keyFor(scope: string, value: string): string {
  return `${scope}:${createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 40)}`;
}

/**
 * Counts one attempt against every rule and allows it only if all pass.
 * Every rule is counted even when an earlier one fails, so an attacker
 * cannot dodge the per-email count by tripping the per-IP one first.
 *
 * FAILS CLOSED: if the counter cannot be read, the attempt is refused and
 * logged. Sign-in needs the database anyway, so this costs nothing extra
 * during an outage, and it never turns an outage into an open door.
 */
export async function allow(rules: Rule[]): Promise<boolean> {
  const db = createServiceClient();
  const results = await Promise.all(
    rules.map(async (r) => {
      const { data, error } = await db.rpc("rate_limit_hit", {
        p_key: r.key,
        p_limit: r.limit,
        p_window_seconds: r.windowSeconds,
      });
      if (error) {
        console.error(`[rate-limit] counter unavailable for ${r.key.split(":")[0]}: ${error.message}`);
        return false;
      }
      return data === true;
    }),
  );
  return results.every(Boolean);
}

/**
 * Waits until at least `ms` have passed since `startedAt`. Used on the
 * send-code path so a member and a non-member take the same time to answer:
 * Supabase sends no email for an unknown address, which would otherwise be
 * measurably faster.
 */
export async function padTo(startedAt: number, ms: number): Promise<void> {
  const left = ms - (Date.now() - startedAt);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}
