import { brandIcon } from "@/lib/brand-icon";

const VARIANTS: Record<string, { size: number; inset: number }> = {
  "192": { size: 192, inset: 0.16 },
  "512": { size: 512, inset: 0.16 },
  maskable: { size: 512, inset: 0.26 },
};

export async function GET(_req: Request, ctx: RouteContext<"/icons/[variant]">) {
  const { variant } = await ctx.params;
  const v = VARIANTS[variant];
  if (!v) return new Response("Not found", { status: 404 });
  const res = brandIcon(v.size, v.inset);
  res.headers.set("Cache-Control", "public, max-age=86400, immutable");
  return res;
}
