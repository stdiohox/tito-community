import { resetDemo, switchPersona } from "@/app/demo/actions";
import { DEMO_USERS, type Persona } from "@/lib/demo/seed";

/*
 * Client preview mode only: the "sample data" banner on every page, and the
 * floating persona switcher. Both render from the root layout, and only
 * when isDemo() is true.
 */

export function DemoBanner() {
  return (
    <div role="note" className="relative z-[60] bg-gold px-4 py-1.5 text-center text-[12px] font-medium leading-snug text-ink">
      Demo — sample data. Nothing here is real, and nothing is investment advice.
    </div>
  );
}

const PERSONAS: { key: Persona; label: string; hint: string }[] = [
  { key: "admin", label: "Admin (Tito)", hint: "Publish picks, manage members" },
  { key: "active", label: "Active member", hint: `${DEMO_USERS.active.name}, 120 days left` },
  { key: "expiring", label: "Expiring member", hint: `${DEMO_USERS.expiring.name}, 2 days left` },
  { key: "expired", label: "Expired member", hint: `${DEMO_USERS.expired.name}, ended 10 days ago` },
  { key: "signedout", label: "Signed out", hint: "The sign-in screen" },
];

export function personaOf(userId: string | null): Persona | "other" {
  if (!userId) return "signedout";
  const hit = (Object.keys(DEMO_USERS) as (keyof typeof DEMO_USERS)[]).find((k) => DEMO_USERS[k].id === userId);
  return hit ?? "other";
}

/**
 * A native <details> disclosure: keyboard- and screen-reader-friendly, and
 * works before (or without) JavaScript. Each persona is a one-click form.
 */
export function PersonaSwitcher({ current, storageFull = false }: { current: Persona | "other"; storageFull?: boolean }) {
  const currentLabel = PERSONAS.find((p) => p.key === current)?.label ?? "Another member";
  return (
    <details className="on-dark group fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] right-3 z-[70] md:bottom-4 md:right-4">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full bg-ink px-4 text-sm font-medium text-ivory shadow-[0_10px_30px_-10px_rgb(0_0_0/0.6)] ring-1 ring-gold/50 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="size-2 rounded-full bg-gold" />
        <span>
          <span className="sr-only">Demo persona: </span>
          Viewing as {currentLabel}
        </span>
        <span aria-hidden className="text-gold transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="absolute bottom-[calc(100%+0.5rem)] right-0 w-72 rounded-2xl bg-ink p-2 text-ivory shadow-[0_20px_60px_-15px_rgb(0_0_0/0.7)] ring-1 ring-gold/30">
        {storageFull ? (
          <p role="status" className="mx-1 mb-2 mt-1 rounded-xl bg-gold/15 px-3 py-2 text-xs leading-relaxed text-ivory">
            This demo session is full, so newer changes may not survive. Use Reset sample data to start fresh.
          </p>
        ) : null}
        <p className="px-3 pb-1 pt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-gold">Switch persona</p>
        <ul>
          {PERSONAS.map((p) => (
            <li key={p.key}>
              <form action={switchPersona}>
                <input type="hidden" name="persona" value={p.key} />
                <button
                  type="submit"
                  aria-current={p.key === current ? "true" : undefined}
                  className={`flex w-full flex-col items-start rounded-xl px-3 py-2 text-left transition-colors hover:bg-ivory/10 ${p.key === current ? "bg-ivory/10" : ""}`}
                >
                  <span className="text-sm font-medium">
                    {p.label}
                    {p.key === current ? <span className="ml-2 text-xs text-gold">current</span> : null}
                  </span>
                  <span className="text-xs text-ivory/70">{p.hint}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
        <div className="mt-1 flex items-center justify-between gap-2 border-t border-ivory/10 px-3 pb-1 pt-2">
          <a href="/demo/outbox" className="rounded px-1 text-xs text-ivory/80 underline underline-offset-4 hover:text-ivory">
            Emails sent (outbox)
          </a>
          <form action={resetDemo}>
            <button type="submit" className="min-h-9 rounded-full px-2 text-xs text-ivory/80 hover:text-ivory">
              Reset sample data
            </button>
          </form>
        </div>
      </div>
    </details>
  );
}
