"use client";

import { useActionState, useState, useTransition } from "react";
import { enrollTotp, verifyTotp, type MfaState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { buttonClass, Field, inputClass } from "@/components/ui";

function CodeForm({ state, action }: { state: MfaState; action: (formData: FormData) => void }) {
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="factorId" value={state.factorId} />
      <Field label="6-digit code" htmlFor="mfa-code">
        <input
          id="mfa-code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          autoFocus
          aria-invalid={Boolean(state.error)}
          aria-describedby={state.error ? "mfa-code-error" : undefined}
          className={`${inputClass} tabular text-center font-mono text-2xl tracking-[0.4em]`}
        />
      </Field>
      {state.error ? (
        <p id="mfa-code-error" role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <SubmitButton pending="Checking…" className="w-full">
        Verify
      </SubmitButton>
    </form>
  );
}

/** Staff who already have an authenticator: one code per session. */
export function MfaChallenge({ factorId }: { factorId: string }) {
  const [state, action] = useActionState(verifyTotp, { factorId });
  return <CodeForm state={state} action={action} />;
}

/** First visit: show a QR code, then confirm it with a code. */
export function MfaEnroll() {
  const [enrolment, setEnrolment] = useState<MfaState | null>(null);
  const [starting, startTransition] = useTransition();
  const [state, action] = useActionState(verifyTotp, {});

  if (!enrolment?.factorId) {
    return (
      <div className="space-y-3">
        {enrolment?.error ? (
          <p role="alert" className="text-sm text-danger">
            {enrolment.error}
          </p>
        ) : null}
        <button
          type="button"
          className={`${buttonClass.primary} w-full`}
          disabled={starting}
          onClick={() => startTransition(async () => setEnrolment(await enrollTotp()))}
        >
          {starting ? "Preparing…" : "Set up an authenticator app"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-muted">
        <li>Open Google Authenticator, 1Password, Authy or similar.</li>
        <li>Scan this code, or type the key below.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <div className="flex justify-center rounded-2xl border border-line bg-white p-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- inline SVG data URL from Supabase */}
        <img src={enrolment.qr} alt="QR code for your authenticator app" width={200} height={200} />
      </div>
      <p className="break-all rounded-xl bg-ivory-deep px-4 py-3 text-center font-mono text-sm">
        <span className="sr-only">Set-up key: </span>
        {enrolment.secret}
      </p>
      <CodeForm state={{ ...enrolment, error: state.error }} action={action} />
    </div>
  );
}
