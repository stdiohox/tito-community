import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Viewer = {
  userId: string;
  email: string;
  aal: "aal1" | "aal2";
};

export type MemberState = {
  viewer: Viewer;
  fullName: string | null;
  isStaff: boolean;
  hasAccess: boolean;
  accessEndsAt: string | null;
  status: "active" | "revoked" | "none";
  statusReason: string | null;
  graceDays: number;
  disclaimerVersion: number;
  disclaimerAccepted: boolean;
};

/**
 * The signed-in user, from a verified JWT. React's cache() dedupes it within
 * one request only; nothing about a session is cached across requests.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) {
    return null;
  }
  const claims = data.claims;
  return {
    userId: claims.sub,
    email: String(claims.email ?? ""),
    aal: claims.aal === "aal2" ? "aal2" : "aal1",
  };
});

/**
 * Everything the gates need, read with the member's own client. has_access()
 * is the same function RLS uses, so the UI and the database cannot disagree
 * about whether someone is in.
 */
export const getMemberState = cache(async (): Promise<MemberState | null> => {
  const viewer = await getViewer();
  if (!viewer) {
    return null;
  }
  const supabase = await createClient();

  const [settings, entitlement, staff, profile, access] = await Promise.all([
    supabase.from("settings").select("grace_days, disclaimer_version").single(),
    supabase
      .from("entitlements")
      .select("access_ends_at, status, status_reason")
      .eq("user_id", viewer.userId)
      .maybeSingle(),
    supabase.from("staff").select("role").eq("user_id", viewer.userId).maybeSingle(),
    supabase.from("profiles").select("full_name").eq("user_id", viewer.userId).maybeSingle(),
    supabase.rpc("has_access"),
  ]);

  // Any failed read throws. Treating a failed read as "no access" would send
  // a paying member to /renew, or an admin to a 404, during a blip.
  const failed = [settings, entitlement, staff, profile, access].find((r) => r.error);
  if (failed?.error) {
    throw new Error(`Could not read membership state: ${failed.error.message}`);
  }

  const disclaimerVersion = settings.data!.disclaimer_version as number;
  const accepted = await supabase
    .from("disclaimer_acceptances")
    .select("version")
    .eq("user_id", viewer.userId)
    .eq("version", disclaimerVersion)
    .maybeSingle();
  if (accepted.error) {
    throw new Error(`Could not read disclaimer acceptance: ${accepted.error.message}`);
  }

  return {
    viewer,
    fullName: (profile.data?.full_name as string | null) ?? null,
    isStaff: Boolean(staff.data),
    hasAccess: access.data === true,
    accessEndsAt: (entitlement.data?.access_ends_at as string | null) ?? null,
    status: (entitlement.data?.status as "active" | "revoked" | undefined) ?? "none",
    statusReason: (entitlement.data?.status_reason as string | null) ?? null,
    graceDays: settings.data!.grace_days as number,
    disclaimerVersion,
    disclaimerAccepted: Boolean(accepted.data),
  };
});

/** Signed in and has accepted the current disclaimer. Access not required. */
export async function requireSignedIn(): Promise<MemberState> {
  const state = await getMemberState();
  if (!state) {
    redirect("/sign-in");
  }
  if (!state.disclaimerAccepted) {
    redirect("/welcome");
  }
  return state;
}

/** Signed in, disclaimer accepted, and access live (or staff). */
export async function requireMember(): Promise<MemberState> {
  const state = await requireSignedIn();
  if (!state.hasAccess) {
    if (!state.isStaff) redirect("/renew");
    // Staff read content through their aal2-only policies, so an aal1 staff
    // session would see an empty feed. Send them to complete two-factor.
    if (state.viewer.aal !== "aal2") redirect("/admin/mfa");
  }
  return state;
}

/**
 * Staff who have passed TOTP in this session. A non-staff visitor gets a 404,
 * not a hint that an admin area exists. The database enforces the same aal2
 * rule on every staff write, so this guard is for the UX, not the security.
 */
export async function requireStaffAal2(): Promise<MemberState> {
  const state = await getMemberState();
  if (!state) {
    redirect("/sign-in");
  }
  if (!state.isStaff) {
    notFound();
  }
  if (state.viewer.aal !== "aal2") {
    redirect("/admin/mfa");
  }
  return state;
}
