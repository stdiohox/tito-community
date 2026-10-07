import { timingSafeEqual } from "node:crypto";
import { drainAlerts, enqueueUnqueuedPicks, purgeLapsedDevices } from "@/lib/notify";

// Vercel runs this on the schedule in vercel.json. Long enough to drain a
// large queue in one go; anything left is picked up next run.
export const maxDuration = 60;

/**
 * The safety net for pick alerts: queues any pick whose alerts were never
 * queued, retries every due or abandoned send, and prunes devices of members
 * lapsed for 30 days.
 *
 * Vercel Cron calls it with "Authorization: Bearer <CRON_SECRET>". Compared
 * in constant time; refuses to run at all when the secret is unset.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "CRON_SECRET is not configured. Refusing to run." }, { status: 500 });
  }
  const given = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const queued = await enqueueUnqueuedPicks();
    // 40s of sending plus at most one in-flight chunk (sends time out at 15s)
    // stays inside maxDuration.
    const result = await drainAlerts({ budgetMs: 40_000 });
    const purged = await purgeLapsedDevices();
    return Response.json({ ok: true, queued, ...result, purged });
  } catch (e) {
    console.error(`[cron/alerts] ${e instanceof Error ? e.message : e}`);
    return Response.json({ error: "Alert run failed; see logs" }, { status: 500 });
  }
}
