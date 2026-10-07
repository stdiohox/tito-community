import Link from "next/link";
import { PICK_FOOTER } from "@/lib/disclaimer";
import { movePct, price, relativeTime, type Market } from "@/lib/format";

export type Pick = {
  id: string;
  ticker: string;
  market: Market;
  action: "buy" | "sell" | "hold" | "trim";
  entry_price: number;
  target_price: number;
  stop_price: number;
  rationale: string;
  author_holds: boolean;
  chart_path: string | null;
  published_at: string;
};

const ACTION_STYLE: Record<Pick["action"], string> = {
  buy: "bg-forest text-ivory",
  sell: "bg-ink text-ivory",
  hold: "border border-gold-deep/50 text-gold-deep",
  trim: "border border-ink/40 text-ink",
};

export function ActionBadge({ action }: { action: Pick["action"] }) {
  return (
    <span className={`inline-flex h-7 items-center rounded-full px-3 font-mono text-[11px] uppercase tracking-[0.16em] ${ACTION_STYLE[action]}`}>
      {action}
    </span>
  );
}

/** Entry, target and stop, with the planned move from entry. */
export function PriceLadder({ pick }: { pick: Pick }) {
  const rows = [
    { label: "Target", value: pick.target_price, move: movePct(pick.entry_price, pick.target_price), tone: "text-forest" },
    { label: "Entry", value: pick.entry_price, move: null, tone: "text-ink" },
    { label: "Stop", value: pick.stop_price, move: movePct(pick.entry_price, pick.stop_price), tone: "text-danger" },
  ];
  return (
    <dl className="grid grid-cols-3 divide-x divide-line overflow-hidden rounded-xl border border-line bg-ivory">
      {rows.map((r) => (
        <div key={r.label} className="min-w-0 px-3 py-3">
          <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{r.label}</dt>
          <dd className={`tabular mt-1 truncate font-mono text-[15px] font-medium ${r.tone}`}>{price(r.value, pick.market)}</dd>
          {r.move ? <dd className="tabular font-mono text-xs text-muted"><span className="sr-only">Move from entry: </span>{r.move}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

export function PickCard({ pick, index = 0, updates = 0 }: { pick: Pick; index?: number; updates?: number }) {
  return (
    <Link
      href={`/picks/${pick.id}`}
      aria-label={`${pick.ticker}, ${pick.action}, ${pick.market}, posted ${relativeTime(pick.published_at)}. Read the pick.`}
      className="rise group block rounded-2xl border border-line bg-paper p-5 shadow-[0_12px_32px_-24px_rgb(13_11_8/0.35)] transition-[transform,border-color] duration-200 ease-[var(--ease-apple)] hover:-translate-y-0.5 hover:border-forest/30 active:scale-[0.99]"
      style={{ ["--i" as string]: Math.min(index, 7) }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
            {pick.market} · {relativeTime(pick.published_at)}
          </p>
          <p className="mt-1 truncate font-display text-[2rem] leading-none text-ink">{pick.ticker}</p>
        </div>
        <ActionBadge action={pick.action} />
      </div>
      <div className="mt-4">
        <PriceLadder pick={pick} />
      </div>
      <p className="mt-4 line-clamp-2 text-[15px] leading-relaxed text-muted">{pick.rationale}</p>
      <div className="mt-4 flex items-center justify-between text-xs text-muted">
        <span>{updates > 0 ? `${updates} update${updates === 1 ? "" : "s"}` : "No updates yet"}</span>
        <span className="font-medium text-forest transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden>
          Read →
        </span>
      </div>
    </Link>
  );
}

export function PickFooter({ holds }: { holds: boolean }) {
  return (
    <p className="text-xs leading-relaxed text-muted">
      {holds ? <strong className="font-medium text-ink">Tito holds this stock. </strong> : null}
      {PICK_FOOTER}
    </p>
  );
}
