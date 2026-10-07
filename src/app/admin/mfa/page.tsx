import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { enrollmentOpen } from "@/lib/staff";
import { MfaChallenge, MfaEnroll } from "./mfa-forms";
import { getMemberState } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, Notice, Wordmark } from "@/components/ui";

export const metadata: Metadata = { title: "Two-factor check" };

/**
 * Every staff write needs an aal2 session (the database checks the JWT's aal
 * claim), so a stolen staff password alone cannot publish a pick to members.
 */
export default async function MfaPage() {
  const state = await getMemberState();
  if (!state) redirect("/sign-in");
  if (!state.isStaff) notFound();
  if (state.viewer.aal === "aal2") redirect("/admin");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw new Error(`Could not list authenticators: ${error.message}`);
  const verified = data.totp.find((f) => f.status === "verified");
  const canEnroll = !verified && (await enrollmentOpen(state.viewer.userId));

  return (
    <main className="min-h-dvh bg-forest px-4 pt-[max(3rem,env(safe-area-inset-top))]">
      <div className="mx-auto max-w-md">
        <div className="mb-8 text-center">
          <Wordmark className="text-4xl" />
          <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-gold">Admin</p>
        </div>
        <Card className="rise p-6 sm:p-8">
          <h1 className="font-display text-3xl text-forest">{verified ? "Confirm it's you" : "Protect the admin area"}</h1>
          <p className="mb-6 mt-2 text-[15px] leading-relaxed text-muted">
            {verified
              ? "Enter the code from your authenticator app to publish and manage members."
              : "Publishing to paying members needs a second factor. Set up an authenticator app once; after that it takes one code per session."}
          </p>
          {verified ? (
            <MfaChallenge factorId={verified.id} />
          ) : canEnroll ? (
            <MfaEnroll />
          ) : (
            <Notice tone="warning">
              Authenticator set-up is closed for this account. The account owner can reopen it (see the README, &ldquo;Lost
              authenticator&rdquo;).
            </Notice>
          )}
        </Card>
      </div>
    </main>
  );
}
