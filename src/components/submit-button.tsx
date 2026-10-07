"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";
import { buttonClass } from "@/components/ui";

export function SubmitButton({
  children,
  pending,
  variant = "primary",
  className = "",
  name,
  value,
}: {
  children: ReactNode;
  pending?: string;
  variant?: keyof typeof buttonClass;
  className?: string;
  name?: string;
  value?: string;
}) {
  const status = useFormStatus();
  const busy = status.pending && (name === undefined || status.data?.get(name) === value);
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={status.pending}
      aria-busy={busy}
      className={`${buttonClass[variant]} ${className}`}
    >
      {busy && pending ? pending : children}
    </button>
  );
}
