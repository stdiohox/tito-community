"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { signIn, type SignInState } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Field, inputClass } from "@/components/ui";

export function SignInForm() {
  const [state, action] = useActionState<SignInState, FormData>(signIn, { step: "email", email: "" });
  // "Use a different email" is purely local: it shows the email step again
  // without a round-trip. It is tied to the state it was clicked on, so the
  // next server response ends it without any effect.
  const [editingFor, setEditingFor] = useState<SignInState | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const onCodeStep = state.step === "code" && editingFor !== state;

  useEffect(() => {
    if (onCodeStep) codeRef.current?.focus();
  }, [onCodeStep, state.sent]);

  if (!onCodeStep) {
    return (
      <form action={action} className="space-y-5" noValidate>
        <input type="hidden" name="intent" value="send" />
        <Field label="Email address" htmlFor="email" hint="Use the email your invitation was sent to.">
          <input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            defaultValue={state.email}
            aria-invalid={Boolean(state.error)}
            aria-describedby={state.error ? "email-error" : undefined}
            className={inputClass}
            placeholder="you@example.com"
          />
        </Field>
        {state.error ? (
          <p id="email-error" role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        ) : null}
        <SubmitButton pending="Sending code…" className="w-full">
          Send me a sign-in code
        </SubmitButton>
      </form>
    );
  }

  return (
    <div className="space-y-5">
      <p role="status" aria-live="polite" className="text-[15px] leading-relaxed text-muted">
        {(state.sent ?? 0) > 1
          ? "If you asked for a code in the last minute, use the one already in your inbox; otherwise a new one is on its way. "
          : ""}
        If <strong className="font-medium text-ink">{state.email}</strong> belongs to a member, a sign-in code is on its
        way. It expires in a few minutes.
      </p>
      <form action={action} className="space-y-5" noValidate>
        <input type="hidden" name="intent" value="verify" />
        <input type="hidden" name="email" value={state.email} />
        <Field label="Sign-in code" htmlFor="code">
          <input
            ref={codeRef}
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={10}
            required
            aria-invalid={Boolean(state.error)}
            aria-describedby={state.error ? "code-error" : undefined}
            className={`${inputClass} tabular text-center font-mono text-2xl tracking-[0.4em]`}
          />
        </Field>
        {state.error ? (
          <p id="code-error" role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        ) : null}
        <SubmitButton pending="Checking…" className="w-full">
          Sign in
        </SubmitButton>
      </form>
      <div className="flex flex-wrap justify-center gap-x-4">
        <form action={action}>
          <input type="hidden" name="intent" value="send" />
          <input type="hidden" name="email" value={state.email} />
          <button type="submit" className="min-h-11 px-2 text-sm text-muted underline-offset-4 hover:text-ink hover:underline">
            Send a new code
          </button>
        </form>
        <button
          type="button"
          onClick={() => setEditingFor(state)}
          className="min-h-11 px-2 text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
        >
          Use a different email
        </button>
      </div>
    </div>
  );
}
