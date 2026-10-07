import type { Metadata } from "next";
import { SignInForm } from "./sign-in-form";
import { Wordmark } from "@/components/ui";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <main className="relative flex min-h-dvh flex-col bg-forest text-ivory">
      {/* Ambient: two soft gold glows and a hairline frame. Static, no motion cost. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[28rem] w-[28rem] -translate-x-1/2 rounded-full bg-gold/15 blur-3xl" />
        <div className="absolute -bottom-48 -right-24 h-[24rem] w-[24rem] rounded-full bg-forest-700 blur-3xl" />
        <div className="absolute inset-3 rounded-[28px] border border-gold/15" />
      </div>

      <div className="relative mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(3rem,env(safe-area-inset-top))]">
        <div className="rise text-center">
          <Wordmark className="text-5xl" />
          <p className="mx-auto mt-4 max-w-xs text-[15px] leading-relaxed text-ivory/75">
            Tito Finance&apos;s private circle. Stock picks, updates and notes for members only.
          </p>
        </div>

        <div className="rise mt-10 rounded-3xl bg-ivory p-6 text-ink shadow-[0_30px_80px_-30px_rgb(0_0_0/0.6)] sm:p-8" style={{ ["--i" as string]: 2 }}>
          <h1 className="mb-5 font-display text-3xl text-forest">Members sign in</h1>
          <SignInForm />
        </div>

        <p className="rise mt-8 text-center text-xs leading-relaxed text-ivory/60" style={{ ["--i" as string]: 4 }}>
          Membership is by invitation. To join, speak to the Tito Finance team.
        </p>
      </div>
    </main>
  );
}
