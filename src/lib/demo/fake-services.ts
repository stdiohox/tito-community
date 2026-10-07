import "server-only";
import { createHmac } from "node:crypto";
import { exec, MAX_UPLOADS, record, type Claims, type Visitor } from "@/lib/demo/db";
import { demoSiteUrl, demoSupabaseUrl } from "@/lib/demo/mode";
import { demoMac } from "@/lib/demo/token";

/*
 * The demo's stand-ins for Supabase Storage and Paystack. Storage keeps the
 * real access rules (rows in storage.objects, checked by the real RLS);
 * Paystack is a simulator with its own checkout page, so payments run the
 * app's real verification and webhook code from end to end.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
export function chartToken(path: string, exp: number): string {
  return demoMac("chart", `${path}:${exp}`).toString("base64url");
}

export async function handleStorage(
  v: Visitor,
  url: URL,
  init: { method: string; headers: Headers; body: string | null; raw: Request },
  auth: { role: "anon" | "authenticated" | "service_role"; claims: Claims },
): Promise<Response> {
  const path = url.pathname.replace(/^.*\/storage\/v1/, "");
  const method = init.method.toUpperCase();
  const asCaller = <T = Record<string, unknown>>(sql: string, params: unknown[]) =>
    exec<T>(v, sql, params, { claims: auth.claims, role: auth.role });

  // Upload: the row goes through RLS (staff with two-factor only).
  const upload = path.match(/^\/object\/charts\/(.+)$/);
  if (upload && method === "POST") {
    const name = decodeURIComponent(upload[1]);
    const form = await init.raw.formData().catch(() => null);
    const file = form ? [...form.values()].find((x): x is File => typeof x !== "string") : null;
    try {
      await exec(v, `insert into storage.objects (bucket_id, name) values ('charts', $1) returning *`, [name], {
        claims: auth.claims,
        role: auth.role,
        persistRowsOf: "storage.objects",
      });
    } catch (e) {
      return json(403, { statusCode: "403", error: "Unauthorized", message: (e as Error).message });
    }
    // Bounded per visitor: past the cap the row still exists (the real
    // rules ran) and a generated chart stands in for the image.
    const used = [...v.uploads.values()].reduce((n, u) => n + u.bytes.length, 0);
    if (file && v.uploads.size < MAX_UPLOADS.count && used + file.size <= MAX_UPLOADS.bytes) {
      v.uploads.set(name, { type: file.type || "image/png", bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    return json(200, { Key: `charts/${name}`, Id: name });
  }

  // Remove (cleanup after a failed publish).
  if (path === "/object/charts" && method === "DELETE") {
    const names = (JSON.parse(init.body ?? "{}") as { prefixes?: string[] }).prefixes ?? [];
    for (const name of names) {
      await exec(v, `delete from storage.objects where bucket_id = 'charts' and name = $1`, [name], { claims: auth.claims, role: auth.role, persist: true });
      v.uploads.delete(name);
    }
    return json(200, names.map((n) => ({ name: n })));
  }

  // Signed URL: only if the caller may read the object (the real RLS).
  const sign = path.match(/^\/object\/sign\/charts\/(.+)$/);
  if (sign && method === "POST") {
    const name = decodeURIComponent(sign[1]);
    const visible = await asCaller(`select 1 from storage.objects where bucket_id = 'charts' and name = $1`, [name]);
    if (visible.rows.length === 0) return json(400, { statusCode: "404", error: "not_found", message: "Object not found" });
    const expiresIn = Number((JSON.parse(init.body ?? "{}") as { expiresIn?: number }).expiresIn ?? 300);
    const exp = Math.floor(Date.now() / 1000) + Math.min(expiresIn, 3600);
    return json(200, { signedURL: `/object/sign/charts/${encodeURIComponent(name)}?exp=${exp}&token=${chartToken(name, exp)}` });
  }

  return json(404, { statusCode: "404", error: "not_found", message: `Demo storage does not implement ${method} ${path}` });
}

// ---------------------------------------------------------------------------
// Paystack simulator
// ---------------------------------------------------------------------------
type Txn = {
  reference: string;
  email: string;
  amount_kobo: string | number;
  plan_code: string | null;
  callback_url: string | null;
  status: string;
  customer_code: string | null;
  paid_at: Date | string | null;
};

export function customerCodeFor(email: string): string {
  return `CUS_demo_${createHmac("sha256", "customer").update(email.toLowerCase()).digest("hex").slice(0, 10)}`;
}

export async function handlePaystack(v: Visitor, url: URL, init: { method: string; body: string | null }): Promise<Response> {
  const method = init.method.toUpperCase();
  const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  const owner = <T = Record<string, unknown>>(sql: string, params: unknown[], persistRowsOf?: string) =>
    exec<T>(v, sql, params, { claims: null, role: null, persistRowsOf });
  const ok = (data: unknown) => json(200, { status: true, message: "OK (simulated)", data });

  if (url.pathname === "/transaction/initialize" && method === "POST") {
    const reference = String(body.reference);
    await owner(
      `insert into public.demo_paystack_transactions (reference, email, amount_kobo, plan_code, callback_url)
       values ($1, $2, $3, $4, $5) returning *`,
      [reference, String(body.email), Number(body.amount), (body.plan as string) ?? null, (body.callback_url as string) ?? null],
      "demo_paystack_transactions",
    );
    return ok({ authorization_url: `${demoSiteUrl()}/demo/paystack/${encodeURIComponent(reference)}`, reference, access_code: "demo" });
  }

  const verify = url.pathname.match(/^\/transaction\/verify\/(.+)$/);
  if (verify && method === "GET") {
    const ref = decodeURIComponent(verify[1]);
    const t = (await owner<Txn>(`select * from public.demo_paystack_transactions where reference = $1`, [ref])).rows[0];
    if (!t) return json(404, { status: false, message: "Transaction reference not found" });
    return ok({
      status: t.status === "success" ? "success" : "abandoned",
      reference: t.reference,
      amount: Number(t.amount_kobo),
      currency: "NGN",
      paid_at: t.paid_at ? new Date(t.paid_at).toISOString() : null,
      customer: { email: t.email, customer_code: t.customer_code ?? customerCodeFor(t.email) },
      plan: t.plan_code,
    });
  }

  if (url.pathname === "/plan" && method === "POST") {
    const code = `PLN_demo_${Date.now().toString(36)}`;
    await owner(
      `insert into public.demo_paystack_plans (plan_code, name, amount_kobo, interval) values ($1, $2, $3, $4) returning *`,
      [code, String(body.name), Number(body.amount), String(body.interval)],
      "demo_paystack_plans",
    );
    return ok({ plan_code: code, name: body.name, amount: body.amount, interval: body.interval });
  }

  if (url.pathname === "/plan" && method === "GET") {
    const rows = (
      await owner<{ plan_code: string; name: string; created_at: Date }>(
        `select plan_code, name, created_at from public.demo_paystack_plans where amount_kobo = $1 and interval = $2`,
        [Number(url.searchParams.get("amount")), url.searchParams.get("interval")],
      )
    ).rows;
    return json(200, { status: true, data: rows.map((r) => ({ ...r, createdAt: new Date(r.created_at).toISOString() })), meta: { pageCount: 1 } });
  }

  const manage = url.pathname.match(/^\/subscription\/(.+)\/manage\/link$/);
  if (manage && method === "GET") {
    return ok({ link: `${demoSiteUrl()}/demo/paystack/manage/${encodeURIComponent(decodeURIComponent(manage[1]))}` });
  }

  return json(404, { status: false, message: `Paystack simulator does not implement ${method} ${url.pathname}` });
}

/** Marks a simulated transaction paid (the "Pay" button on the checkout page). */
export async function markTransactionPaid(v: Visitor, reference: string): Promise<Txn | null> {
  const res = await exec<Txn>(
    v,
    `update public.demo_paystack_transactions
        set status = 'success', paid_at = $2::timestamptz, customer_code = coalesce(customer_code, $3)
      where reference = $1 and status = 'pending'
      returning *`,
    [reference, new Date().toISOString(), null],
    { claims: null, role: null },
  );
  const t = res.rows[0];
  if (!t) return null;
  const code = customerCodeFor(t.email);
  await exec(v, `update public.demo_paystack_transactions set customer_code = $2 where reference = $1`, [reference, code], {
    claims: null,
    role: null,
  });
  // One log entry with explicit values, so a replay lands identically.
  await record(
    v,
    `update public.demo_paystack_transactions set status = 'success', paid_at = $2::timestamptz, customer_code = $3 where reference = $1`,
    [reference, new Date(t.paid_at as string | Date).toISOString(), code],
    null,
  );
  return { ...t, customer_code: code };
}

export const demoStorageBase = () => `${demoSupabaseUrl()}/storage/v1`;
