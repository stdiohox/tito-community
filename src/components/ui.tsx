import type { ReactNode } from "react";

/** The wordmark. Gold "Circle" only ever sits on Forest or Ink. */
export function Wordmark({ tone = "light", className = "" }: { tone?: "light" | "dark"; className?: string }) {
  return (
    <span className={`font-display text-2xl leading-none tracking-tight ${className}`}>
      <span className={tone === "light" ? "text-ivory" : "text-forest"}>Tito</span>{" "}
      <span className={`italic ${tone === "light" ? "text-gold" : "text-gold-deep"}`}>Circle</span>
    </span>
  );
}

export function SkipLink({ target = "content" }: { target?: string }) {
  return (
    <a href={`#${target}`} className="skip-link">
      Skip to content
    </a>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold-deep">{children}</p>;
}

export function PageTitle({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <header className="mb-6 space-y-2">
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h1 className="font-display text-[2.4rem] leading-[1.05] text-ink">{title}</h1>
      {children ? <div className="text-[15px] leading-relaxed text-muted">{children}</div> : null}
    </header>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-line bg-paper shadow-[0_1px_0_rgb(13_11_8/0.04),0_12px_32px_-20px_rgb(13_11_8/0.25)] ${className}`}>
      {children}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "success" | "warning" | "error";
  children: ReactNode;
}) {
  const styles = {
    info: "border-line bg-ivory-deep text-ink",
    success: "border-forest/25 bg-forest/[0.06] text-forest",
    warning: "border-gold/60 bg-gold-soft/50 text-ink",
    error: "border-danger/30 bg-danger/[0.06] text-danger",
  }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 text-sm leading-relaxed ${styles}`}>
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-12 text-center">
      <p className="font-display text-2xl text-forest">{title}</p>
      {children ? <p className="mx-auto mt-2 max-w-xs text-sm text-muted">{children}</p> : null}
    </div>
  );
}

export const buttonClass = {
  primary:
    "inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-forest px-6 text-[15px] font-medium text-ivory transition-[transform,background-color] duration-150 ease-[var(--ease-apple)] hover:bg-forest-700 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
  gold: "inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-gold px-6 text-[15px] font-semibold text-ink transition-[transform,filter] duration-150 ease-[var(--ease-apple)] hover:brightness-105 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
  ghost:
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-control px-5 text-sm font-medium text-ink transition-[transform,background-color] duration-150 hover:bg-ivory-deep active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
  danger:
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-danger/40 px-5 text-sm font-medium text-danger transition-[transform,background-color] duration-150 hover:bg-danger/[0.06] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
};

export const inputClass =
  "block w-full rounded-xl border border-control bg-paper px-4 py-3 text-[16px] text-ink placeholder:text-muted transition-colors focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest/40";

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
