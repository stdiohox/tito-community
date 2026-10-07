"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { afterResponse } from "@/lib/after-response";
import { z } from "zod";
import { requireStaffAal2 } from "@/lib/auth";
import { env } from "@/lib/env";
import { emailConfigured, layout, sendEmail } from "@/lib/email";
import { alertAdminsOfPublish, drainAlerts, enqueuePickAlerts, enqueueUnqueuedPicks } from "@/lib/notify";
import { describePlanOutcome, ensurePaystackPlan } from "@/lib/plans";
import { createClient, createServiceClient } from "@/lib/supabase/server";

/*
 * Every action re-checks staff + aal2 itself (never trusting that the page
 * that rendered the form did), and every content write goes through the
 * staff member's own session, so RLS and the audit triggers see a real
 * person. The database repeats the aal2 check on each write.
 */

export type FormState = { ok?: boolean; error?: string; message?: string; values?: Record<string, string> };

// React 19 resets a form after its action runs. On failure the typed values
// come back here and are rendered as defaultValue, so nothing is lost.
function echo(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData) if (typeof v === "string" && !k.startsWith("$ACTION")) out[k] = v;
  return out;
}

const price = z.coerce.number().positive().max(1_000_000_000);

const pickSchema = z
  .object({
    ticker: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9.\-]{1,15}$/, "Ticker: letters, numbers, dots and dashes, up to 15."),
    market: z.enum(["NGX", "US", "OTHER"]),
    action: z.enum(["buy", "sell", "hold", "trim"]),
    entry_price: price,
    target_price: price,
    stop_price: price,
    rationale: z.string().trim().min(20, "Rationale needs at least 20 characters.").max(4000),
    author_holds: z.boolean(),
  })
  .superRefine((p, ctx) => {
    if (p.action === "buy" && !(p.target_price > p.entry_price && p.stop_price < p.entry_price)) {
      ctx.addIssue({ code: "custom", message: "For a buy, target must be above entry and stop below it." });
    }
    if (p.action === "sell" && !(p.target_price < p.entry_price && p.stop_price > p.entry_price)) {
      ctx.addIssue({ code: "custom", message: "For a sell, target must be below entry and stop above it." });
    }
  });

const CHART_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export async function createPick(_prev: FormState, formData: FormData): Promise<FormState> {
  const state = await requireStaffAal2();
  const parsed = pickSchema.safeParse({
    ticker: formData.get("ticker"),
    market: formData.get("market"),
    action: formData.get("action"),
    entry_price: formData.get("entry_price"),
    target_price: formData.get("target_price"),
    stop_price: formData.get("stop_price"),
    rationale: formData.get("rationale"),
    author_holds: formData.get("author_holds") === "on",
  });
  if (!parsed.success) return { values: echo(formData), error: parsed.error.issues[0]?.message ?? "Check the form." };

  const supabase = await createClient();

  let chartPath: string | null = null;
  const chart = formData.get("chart");
  if (chart instanceof File && chart.size > 0) {
    const ext = CHART_TYPES[chart.type];
    if (!ext) return { values: echo(formData), error: "Chart must be a PNG, JPG or WebP image." };
    if (chart.size > 4 * 1024 * 1024) return { values: echo(formData), error: "Chart must be 4 MB or smaller." };
    chartPath = `${state.viewer.userId}/${randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from("charts").upload(chartPath, chart, { contentType: chart.type, upsert: false });
    if (error) return { values: echo(formData), error: `Chart upload failed: ${error.message}` };
  }

  const { data, error } = await supabase
    .from("picks")
    .insert({ ...parsed.data, chart_path: chartPath, author_id: state.viewer.userId })
    .select("id")
    .single();
  if (error) {
    if (chartPath) await supabase.storage.from("charts").remove([chartPath]);
    return { values: echo(formData), error: `Could not publish: ${error.message}` };
  }

  const summary = `${parsed.data.action.toUpperCase()} ${parsed.data.ticker} (${parsed.data.market})`;
  // Queue first, then send. If this process dies at any point after the
  // queue write, the cron (or "Send pending alerts now") finishes the job.
  await afterResponse(async () => {
    const results = await Promise.allSettled([
      enqueuePickAlerts(data.id).then(() => drainAlerts({ budgetMs: 40_000 })),
      alertAdminsOfPublish(`pick ${summary}`, state.viewer.email),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        console.error(`[publish] after-publish task failed for pick ${data.id}: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
      }
    }
  });

  revalidatePath("/picks");
  redirect(`/admin/picks/${data.id}?published=1`);
}

const updateSchema = z.object({
  pick_id: z.uuid(),
  kind: z.enum(["note", "target_hit", "stop_hit", "closed", "revised"]),
  body: z.string().trim().min(2).max(2000),
});

export async function postUpdate(_prev: FormState, formData: FormData): Promise<FormState> {
  const state = await requireStaffAal2();
  const parsed = updateSchema.safeParse({
    pick_id: formData.get("pick_id"),
    kind: formData.get("kind"),
    body: formData.get("body"),
  });
  if (!parsed.success) return { values: echo(formData), error: "Write the update (2 to 2,000 characters)." };

  const supabase = await createClient();
  const { data: pick } = await supabase.from("picks").select("ticker").eq("id", parsed.data.pick_id).maybeSingle();
  const { error } = await supabase.from("pick_updates").insert({ ...parsed.data, author_id: state.viewer.userId });
  if (error) return { values: echo(formData), error: `Could not post: ${error.message}` };

  await afterResponse(() => alertAdminsOfPublish(`update on ${pick?.ticker ?? "a pick"} (${parsed.data.kind})`, state.viewer.email));
  revalidatePath(`/admin/picks/${parsed.data.pick_id}`);
  revalidatePath(`/picks/${parsed.data.pick_id}`);
  return { ok: true, message: "Update posted." };
}

export async function deletePick(formData: FormData) {
  await requireStaffAal2();
  const id = z.uuid().parse(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.from("picks").update({ deleted_at: new Date().toISOString() }).eq("id", id).is("deleted_at", null);
  if (error) throw new Error(`Could not remove pick: ${error.message}`);
  revalidatePath("/picks");
  redirect("/admin/picks?removed=1");
}

const announcementSchema = z.object({
  title: z.string().trim().min(2).max(140),
  body: z.string().trim().min(2).max(4000),
  pinned: z.boolean(),
});

export async function createAnnouncement(_prev: FormState, formData: FormData): Promise<FormState> {
  const state = await requireStaffAal2();
  const parsed = announcementSchema.safeParse({
    title: formData.get("title"),
    body: formData.get("body"),
    pinned: formData.get("pinned") === "on",
  });
  if (!parsed.success) return { values: echo(formData), error: "Give it a title (2 to 140 characters) and a message." };

  const supabase = await createClient();
  const { error } = await supabase.from("announcements").insert({ ...parsed.data, author_id: state.viewer.userId });
  if (error) return { values: echo(formData), error: `Could not post: ${error.message}` };

  await afterResponse(() => alertAdminsOfPublish(`notice "${parsed.data.title}"`, state.viewer.email));
  revalidatePath("/announcements");
  revalidatePath("/admin/announcements");
  return { ok: true, message: "Notice posted." };
}

export async function setAnnouncementPinned(formData: FormData) {
  await requireStaffAal2();
  const id = z.uuid().parse(formData.get("id"));
  const pinned = formData.get("pinned") === "true";
  const supabase = await createClient();
  const { error } = await supabase.from("announcements").update({ pinned }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/admin/announcements");
}

export async function deleteAnnouncement(formData: FormData) {
  await requireStaffAal2();
  const id = z.uuid().parse(formData.get("id"));
  const supabase = await createClient();
  const { error } = await supabase.from("announcements").update({ deleted_at: new Date().toISOString() }).eq("id", id).is("deleted_at", null);
  if (error) throw new Error(error.message);
  revalidatePath("/admin/announcements");
}

const inviteSchema = z.object({
  email: z.email().max(254).transform((e) => e.trim().toLowerCase()),
  full_name: z.string().trim().max(120).optional(),
  days: z.coerce.number().int().min(0).max(730),
});

/**
 * Invite-only membership. Creating the auth user needs the service role (it
 * is the only way accounts come into existence); the access grant then runs
 * as the staff member so the audit log names them.
 */
export async function inviteMember(_prev: FormState, formData: FormData): Promise<FormState> {
  const state = await requireStaffAal2();
  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    full_name: formData.get("full_name") || undefined,
    days: formData.get("days") || 0,
  });
  if (!parsed.success) return { values: echo(formData), error: "Enter a valid email, and days between 0 and 730." };
  const { email, full_name, days } = parsed.data;

  const admin = createServiceClient();
  const { data: created, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !created.user) {
    const exists = error?.code === "email_exists" || error?.code === "user_already_exists";
    return { values: echo(formData), error: exists ? "That email already has an account. Use Extend on the member list." : `Could not invite: ${error?.message}` };
  }
  const userId = created.user.id;

  if (full_name) {
    const { error: nameError } = await admin.from("profiles").update({ full_name }).eq("user_id", userId);
    if (nameError) console.error(`[invite] name not saved for ${userId}: ${nameError.message}`);
  }
  const { error: auditError } = await admin.from("audit_log").insert({
    actor_id: state.viewer.userId,
    action: "member_invited",
    target_type: "profiles",
    target_id: userId,
    detail: { email, days },
  });
  if (auditError) {
    // The account exists now, so say so plainly rather than pretend nothing happened.
    console.error(`[invite] audit entry failed for ${userId}: ${auditError.message}`);
    return { error: `Account created for ${email}, but the audit entry failed: ${auditError.message}. Do not retry the invite; extend access from the member list.` };
  }

  if (days > 0) {
    const supabase = await createClient();
    const { error: grantError } = await supabase.rpc("admin_extend_access", {
      p_user_id: userId,
      p_days: days,
      p_reason: "Invitation",
    });
    if (grantError) return { values: echo(formData), error: `Invited, but access was not granted: ${grantError.message}` };
  }

  const url = `${env.siteUrl()}/sign-in`;
  const sent = await sendEmail({
    to: email,
    subject: "You're invited to Tito Circle",
    text: `${full_name ? `Hi ${full_name},\n\n` : ""}You've been invited to Tito Circle, Tito Finance's private members' community.\n\nSign in with this email address at ${url}. We'll send you a one-time code; there is no password.`,
    html: layout(
      "You're invited to Tito Circle",
      [
        `${full_name ? `Hi ${full_name}. ` : ""}You've been invited to Tito Circle, Tito Finance's private members' community.`,
        "Sign in with this email address. We'll send you a one-time code; there is no password to remember.",
      ],
      { label: "Sign in", url },
    ),
  });

  revalidatePath("/admin/members");
  return {
    ok: true,
    message: sent
      ? `Invited ${email}${days > 0 ? ` with ${days} days of access` : ""}. They've been emailed.`
      : `Invited ${email}${days > 0 ? ` with ${days} days of access` : ""}, but the invitation email was not sent (${emailConfigured() ? "Resend reported an error; see the server log" : "email is not configured"}). Tell them to sign in at ${url}.`,
  };
}

export async function extendAccess(formData: FormData) {
  await requireStaffAal2();
  const userId = z.uuid().parse(formData.get("user_id"));
  const days = z.coerce.number().int().min(1).max(730).parse(formData.get("days"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_extend_access", { p_user_id: userId, p_days: days, p_reason: "Admin extension" });
  if (error) throw new Error(error.message);
  revalidatePath("/admin/members");
}

export async function setAccessStatus(formData: FormData) {
  await requireStaffAal2();
  const userId = z.uuid().parse(formData.get("user_id"));
  const status = z.enum(["active", "revoked"]).parse(formData.get("status"));
  const reason = z.string().trim().max(300).optional().parse(formData.get("reason") || undefined);
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_access_status", {
    p_user_id: userId,
    p_status: status,
    p_reason: reason ?? (status === "revoked" ? "Suspended by admin" : null),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/admin/members");
}

const productSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  price_naira: z.coerce.number().min(100).max(100_000_000),
  access_months: z.coerce.number().pipe(z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)])),
});

/**
 * Creates the product, then its Paystack plan so card members can auto-renew.
 * If Paystack is unavailable the product still exists and sells as one-off;
 * the plan can be created later from the product list.
 */
export async function createProduct(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireStaffAal2();
  const parsed = productSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    price_naira: formData.get("price_naira"),
    access_months: formData.get("access_months"),
  });
  if (!parsed.success) return { values: echo(formData), error: "Name (2 to 80 characters), price of at least ₦100, and a length of 1, 3, 6 or 12 months." };
  const { name, description, price_naira, access_months } = parsed.data;
  const priceKobo = Math.round(price_naira * 100);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .insert({ name, description, price_kobo: priceKobo, access_months })
    .select("id")
    .single();
  if (error) return { values: echo(formData), error: `Could not create product: ${error.message}` };

  revalidatePath("/admin/products");
  const outcome = await ensurePaystackPlan(data.id);
  return { ok: true, message: `Created "${name}". ${describePlanOutcome(outcome)}` };
}

/** Safe to click twice: ensurePaystackPlan creates at most one plan. */
export async function retryPlan(formData: FormData) {
  await requireStaffAal2();
  const id = z.uuid().parse(formData.get("id"));
  const outcome = await ensurePaystackPlan(id);
  revalidatePath("/admin/products");
  redirect(`/admin/products?plan=${outcome.status}`);
}

export async function setProductActive(formData: FormData) {
  await requireStaffAal2();
  const id = z.uuid().parse(formData.get("id"));
  const active = formData.get("active") === "true";
  const supabase = await createClient();
  const { error } = await supabase.from("products").update({ active }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/admin/products");
}

/**
 * Retries every pick alert that is due now (failed sends after their backoff,
 * and any batch a crashed worker left behind). The cron does this every five
 * minutes; this is the same thing on demand.
 */
export async function sendPendingAlerts() {
  await requireStaffAal2();
  let flag: string;
  try {
    await enqueueUnqueuedPicks();
    const r = await drainAlerts({ budgetMs: 25_000 });
    flag = `${r.sent}-${r.retrying}-${r.failed}`;
  } catch (e) {
    console.error(`[alerts] manual run failed: ${e instanceof Error ? e.message : e}`);
    flag = "error";
  }
  revalidatePath("/admin");
  // Outside the try: redirect() works by throwing.
  redirect(`/admin?alerts=${flag}`);
}
