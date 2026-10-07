"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getMemberState, type MemberState } from "@/lib/auth";
import { env } from "@/lib/env";
import { layout, sendEmail } from "@/lib/email";
import { enrollmentOpen } from "@/lib/staff";
import { allow, keyFor, LIMITS } from "@/lib/rate-limit";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export type MfaState = {
  factorId?: string;
  qr?: string;
  secret?: string;
  error?: string;
};

async function requireStaff(): Promise<MemberState> {
  const state = await getMemberState();
  if (!state) redirect("/sign-in");
  if (!state.isStaff) redirect("/picks");
  return state;
}

/**
 * Starts TOTP enrolment, and only while the enrolment window is open.
 *
 * Staff sign in with an email code, so without the window anyone holding a
 * staff mailbox could enrol THEIR OWN authenticator and reach aal2. The
 * window is opened only by the service role (seed script, or SQL after a lost
 * phone) and closed the moment a factor is verified. Enrolling while a
 * verified factor exists is refused too.
 */
export async function enrollTotp(): Promise<MfaState> {
  const state = await requireStaff();
  if (!(await enrollmentOpen(state.viewer.userId))) {
    return { error: "Authenticator set-up is closed for this account. Ask the account owner to reopen it." };
  }

  const supabase = await createClient();
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError) return { error: "Could not check your existing authenticators. Try again." };
  if (factors.totp.some((f) => f.status === "verified")) {
    return { error: "An authenticator is already set up. Enter its code instead." };
  }
  for (const f of factors.all) {
    if (f.factor_type === "totp" && f.status !== "verified") {
      await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `Tito Circle ${new Date().toISOString().slice(0, 10)}`,
    issuer: "Tito Circle",
  });
  if (error || !data) return { error: error?.message ?? "Could not start set-up." };
  return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}

const verifySchema = z.object({
  factorId: z.uuid(),
  code: z.string().trim().regex(/^\d{6}$/),
});

export async function verifyTotp(prev: MfaState, formData: FormData): Promise<MfaState> {
  const state = await requireStaff();
  const parsed = verifySchema.safeParse({ factorId: formData.get("factorId"), code: formData.get("code") });
  if (!parsed.success) return { ...prev, error: "Enter the 6-digit code from your authenticator app." };

  // A 6-digit code is guessable without a cap.
  const allowed = await allow([{ key: keyFor("totp-verify-user", state.viewer.userId), ...LIMITS.totpVerifyPerUser }]);
  if (!allowed) return { ...prev, error: "Too many attempts. Wait 15 minutes, then try again." };

  const supabase = await createClient();
  // The factor must be one of this user's own.
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError) return { ...prev, error: "Could not check your authenticators. Try again." };
  const factor = factors.all.find((f) => f.id === parsed.data.factorId && f.factor_type === "totp");
  if (!factor) return { ...prev, error: "That authenticator is not on your account." };
  const enrolling = factor.status !== "verified";

  const { error } = await supabase.auth.mfa.challengeAndVerify(parsed.data);
  if (error) return { ...prev, error: "That code did not match. Check your phone's time is correct and try again." };

  if (enrolling) {
    // Close the window and tell the owners, so a new authenticator on a
    // staff account can never appear unnoticed.
    const { error: closeError } = await createServiceClient()
      .from("staff")
      .update({ mfa_enrollment_open: false })
      .eq("user_id", state.viewer.userId);
    if (closeError) console.error(`[mfa] could not close enrolment window: ${closeError.message}`);

    const to = [...new Set([state.viewer.email, ...env.adminAlertEmails()])].filter(Boolean);
    after(() =>
      Promise.all(
        to.map((address) =>
          sendEmail({
            to: address,
            subject: "A new authenticator was added to a Tito Circle admin account",
            text: `An authenticator app was just set up for ${state.viewer.email}.\n\nIf this was not you, remove the factor in Supabase (Authentication → Users) and rotate access now.`,
            html: layout("New authenticator added", [
              `An authenticator app was just set up for ${state.viewer.email}.`,
              "If this was not you, remove the factor in Supabase (Authentication → Users) and rotate access now.",
            ]),
          }),
        ),
      ),
    );
  }

  // The session is now aal2; its cookies were rewritten by the action.
  redirect("/admin");
}
