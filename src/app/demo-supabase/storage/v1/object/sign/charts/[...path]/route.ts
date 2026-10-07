import { currentVisitor, ownerQuery } from "@/lib/demo/db";
import { macMatches } from "@/lib/demo/token";
import { isDemo } from "@/lib/demo/mode";

/**
 * Client preview mode only: serves the chart behind a demo signed URL. The
 * token was issued only after the real storage RLS allowed the read, and it
 * expires like a Supabase signed URL. An uploaded chart is served as
 * uploaded; otherwise the chart is drawn from the pick's own levels.
 */
export async function GET(request: Request, ctx: RouteContext<"/demo-supabase/storage/v1/object/sign/charts/[...path]">) {
  if (!isDemo()) return new Response("Not found", { status: 404 });
  const { path } = await ctx.params;
  const name = path.map(decodeURIComponent).join("/");
  const url = new URL(request.url);
  const exp = Number(url.searchParams.get("exp"));
  if (!exp || exp * 1000 < Date.now() || !macMatches("chart", `${name}:${exp}`, url.searchParams.get("token") ?? "")) {
    return new Response("Link expired", { status: 403 });
  }

  const upload = (await currentVisitor()).uploads.get(name);
  if (upload) {
    return new Response(Buffer.from(upload.bytes), { headers: { "content-type": upload.type, "cache-control": "private, max-age=300" } });
  }

  const [pick] = await ownerQuery<{ ticker: string; entry_price: string; target_price: string; stop_price: string; action: string }>(
    `select ticker, entry_price, target_price, stop_price, action from public.picks where chart_path = $1`,
    [name],
  );
  if (!pick) return new Response("Not found", { status: 404 });
  return new Response(drawChart(pick), {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "private, max-age=300" },
  });
}

/** A deterministic price path for the ticker, with entry, target and stop lines. */
function drawChart(p: { ticker: string; entry_price: string; target_price: string; stop_price: string }): string {
  const entry = Number(p.entry_price);
  const target = Number(p.target_price);
  const stop = Number(p.stop_price);
  const lo = Math.min(stop, target, entry) * 0.96;
  const hi = Math.max(stop, target, entry) * 1.04;
  const W = 800;
  const H = 420;
  const pad = { l: 16, r: 136, t: 24, b: 28 };
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const x = (i: number, n: number) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);

  let seed = [...p.ticker].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const n = 90;
  const points: number[] = [];
  let v = entry * (0.9 + rand() * 0.06);
  for (let i = 0; i < n; i++) {
    const pull = (entry * (i < n * 0.75 ? 1 : 1.05) - v) * 0.06;
    v = Math.min(hi * 0.99, Math.max(lo * 1.01, v + pull + (rand() - 0.5) * entry * 0.025));
    points.push(v);
  }
  const line = points.map((pt, i) => `${i ? "L" : "M"}${x(i, n).toFixed(1)},${y(pt).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1, n).toFixed(1)},${H - pad.b} L${pad.l},${H - pad.b} Z`;
  const fmt = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString("en-NG") : v.toFixed(2));
  const level = (val: number, label: string, color: string) =>
    `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(val)}" y2="${y(val)}" stroke="${color}" stroke-width="1.5" stroke-dasharray="6 5"/>
     <text x="${W - pad.r + 8}" y="${y(val) + 4}" font-family="monospace" font-size="13" fill="${color}">${label} ${fmt(val)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Sample chart for ${p.ticker}">
  <rect width="${W}" height="${H}" fill="#FFFDF8"/>
  <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#1A3A16" stop-opacity="0.18"/><stop offset="1" stop-color="#1A3A16" stop-opacity="0"/></linearGradient></defs>
  <path d="${area}" fill="url(#g)"/>
  <path d="${line}" fill="none" stroke="#1A3A16" stroke-width="2.5" stroke-linejoin="round"/>
  ${level(target, "Target", "#1A3A16")}
  ${level(entry, "Entry", "#0D0B08")}
  ${level(stop, "Stop", "#8C2F1B")}
  <text x="${pad.l + 4}" y="${pad.t + 4}" font-family="Georgia, serif" font-size="22" fill="#0D0B08">${p.ticker}</text>
  <text x="${pad.l + 4}" y="${H - 8}" font-family="monospace" font-size="11" fill="#5B564C">Sample chart · demo data</text>
</svg>`;
}
