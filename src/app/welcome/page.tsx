import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { acceptDisclaimer } from "./actions";
import { getMemberState } from "@/lib/auth";
import { DISCLAIMERS } from "@/lib/disclaimer";
import { SubmitButton } from "@/components/submit-button";
import { Wordmark } from "@/components/ui";

export const metadata: Metadata = { title: "Before you continue" };

export default async function WelcomePage() {
  const state = await getMemberState();
  if (!state) redirect("/sign-in");
  if (state.disclaimerAccepted) redirect("/picks");

  const text = DISCLAIMERS[state.disclaimerVersion];
  if (!text) {
    throw new Error(`No disclaimer wording for version ${state.disclaimerVersion}. Add it to src/lib/disclaimer.ts.`);
  }

  return (
    <main className="min-h-dvh bg-forest px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))]">
      <div className="mx-auto max-w-lg">
        <div className="mb-8 text-center">
          <Wordmark className="text-4xl" />
        </div>
        <article className="rise rounded-3xl bg-ivory p-6 sm:p-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold-deep">Disclaimer · version {state.disclaimerVersion}</p>
          <h1 className="mt-2 font-display text-[2.2rem] leading-tight text-forest">{text.title}</h1>
          <ol className="mt-6 space-y-4">
            {text.points.map((p, i) => (
              <li key={i} className="flex gap-4 text-[15px] leading-relaxed text-ink">
                <span className="tabular mt-0.5 font-mono text-xs text-gold-deep">{String(i + 1).padStart(2, "0")}</span>
                <span>{p}</span>
              </li>
            ))}
          </ol>
          <form action={acceptDisclaimer} className="mt-8 space-y-4 border-t border-line pt-6">
            <input type="hidden" name="version" value={state.disclaimerVersion} />
            <label className="flex items-start gap-3 text-[15px] leading-relaxed">
              <input type="checkbox" name="agree" required className="mt-1 size-5 shrink-0 accent-forest" />
              <span>I have read and understand this. I accept that nothing in Tito Circle is personal financial advice.</span>
            </label>
            <SubmitButton pending="Saving…" className="w-full">
              Accept and enter
            </SubmitButton>
          </form>
        </article>
      </div>
    </main>
  );
}
