"use server";

import { after } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { layout, sendEmail } from "@/lib/email";
import { shortDateTime } from "@/lib/format";
import { allow, clientIp, padTo, signInRules } from "@/lib/rate-limit";

export type SignInState = {
  step: "email" | "code";
  email: string;
  error?: string;
  /** Bumped each time a code is (re)sent, so the screen can announce it. */
  sent?: number;
};

/**
 * One action, one state: the form posts intent=send or intent=verify. Two
 * independent action states could drift apart and strand the member on the
 * wrong step.
 */
export async function signIn(prev: SignInState, formData: FormData): Promise<SignInState> {
  return formData.get("intent") === "verify" ? verifyCode(prev, formData) : sendCode(prev, formData);
}

const emailSchema = z.email().max(254).transform((e) => e.trim().toLowerCase());
const codeSchema = z.string().trim().regex(/^\d{6,10}$/);

const TOO_MANY = "Too many attempts. Wait 15 minutes, then try again.";
// Every send-code answer takes at least this long, member or not.
const SEND_MIN_MS = 600;

/**
 * Invite-only: shouldCreateUser is false, AND public sign-ups are disabled in
 * the Supabase project (README step 3). The flag alone is not a control,
 * because anyone can call the Auth API directly.
 *
 * The response never reveals whether an address belongs to a member: a
 * non-member sees the same "check your email" step as a member.
 */
async function sendCode(prev: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success) {
    return { step: "email", email: String(formData.get("email") ?? ""), error: "Enter a valid email address." };
  }
  const email = parsed.data;
  const startedAt = Date.now();

  // Our limits run first and apply to every address alike, so being
  // limited says nothing about whether the address is a member.
  const allowed = await allow(signInRules("send", await clientIp(), email));
  if (!allowed) {
    await padTo(startedAt, SEND_MIN_MS);
    return { step: "email", email, error: TOO_MANY };
  }

  // The code is requested AFTER the response is sent. Supabase answers an
  // unknown address faster than a member (no email goes out), so awaiting it
  // here would let response time reveal membership. Deferred, every answer
  // takes the same path whatever the address.
  const supabase = await createClient();
  after(async () => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    if (error) {
      // Unknown address, sign-ups disabled, Supabase's own per-address
      // throttle: never shown, because each would reveal membership. Logged
      // for the operator.
      console.warn(`[sign-in] OTP not sent: ${error.code ?? error.status} ${error.message}`);
    }
  });

  // A small floor smooths the remaining variance (the rate-limit query).
  await padTo(startedAt, SEND_MIN_MS);
  return { step: "code", email, sent: (prev.sent ?? 0) + 1 };
}

async function verifyCode(prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = emailSchema.safeParse(formData.get("email"));
  const code = codeSchema.safeParse(formData.get("code"));
  if (!email.success) {
    return { step: "email", email: "", error: "Start again with your email address." };
  }
  if (!code.success) {
    return { ...prev, step: "code", email: email.data, error: "Enter the code from your email." };
  }

  // Caps code guessing per IP, per address-and-IP, and (loosely) per
  // address, on top of Supabase's own limits.
  const allowed = await allow(signInRules("verify", await clientIp(), email.data));
  if (!allowed) {
    return { ...prev, step: "code", email: email.data, error: TOO_MANY };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ email: email.data, token: code.data, type: "email" });
  if (error) {
    return { ...prev, step: "code", email: email.data, error: "That code is wrong or has expired. Request a new one." };
  }

  // A sign-in alert discourages shared logins and tells a member at once if
  // someone else got in. Sent after the response so sign-in stays fast.
  const agent = (await headers()).get("user-agent") ?? "an unknown device";
  after(async () => {
    await sendEmail({
      to: email.data,
      subject: "New sign-in to Tito Circle",
      text: `Someone signed in to your Tito Circle account at ${shortDateTime(new Date().toISOString())} (Lagos time) from ${agent}.\n\nIf this was not you, reply to this email straight away.`,
      html: layout("New sign-in to your account", [
        `Someone signed in at ${shortDateTime(new Date().toISOString())} (Lagos time) from ${agent}.`,
        "If this was you, there is nothing to do. If it was not, reply to this email straight away.",
      ]),
    });
  });

  redirect("/");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}
