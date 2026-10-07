const DAY = 86_400_000;

export function naira(kobo: number): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(kobo / 100);
}

export type Market = "NGX" | "US" | "OTHER";

export function price(value: number, market: Market): string {
  const n = Number(value);
  const digits = n >= 1000 ? 0 : 2;
  const formatted = n.toLocaleString("en-NG", { minimumFractionDigits: digits, maximumFractionDigits: 2 });
  if (market === "NGX") return `₦${formatted}`;
  if (market === "US") return `$${formatted}`;
  return formatted;
}

/** Percentage move from entry, signed. Planned levels, not a track record. */
export function movePct(from: number, to: number): string {
  const pct = ((Number(to) - Number(from)) / Number(from)) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Africa/Lagos",
  });
}

export function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Lagos",
  });
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return longDate(iso);
}

/** Whole days until a date, rounded up; negative once it has passed. */
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.ceil((new Date(iso).getTime() - now) / DAY);
}

export function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY).toISOString();
}

export const ACCESS_MONTH_LABEL: Record<number, string> = {
  1: "1 month",
  3: "3 months",
  6: "6 months",
  12: "12 months",
};
