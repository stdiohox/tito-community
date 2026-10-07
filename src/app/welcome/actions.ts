"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function acceptDisclaimer(formData: FormData) {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  if (formData.get("agree") !== "on") redirect("/welcome");

  const version = Number(formData.get("version"));
  if (!Number.isInteger(version) || version < 1) redirect("/welcome");
  const agent = ((await headers()).get("user-agent") ?? "").slice(0, 400);

  // RLS only accepts the CURRENT version for the caller themself, so a stale
  // or forged version number fails here rather than being recorded.
  const supabase = await createClient();
  const { error } = await supabase
    .from("disclaimer_acceptances")
    .insert({ user_id: viewer.userId, version, user_agent: agent });

  if (error && error.code !== "23505") {
    throw new Error(`Could not record acceptance: ${error.message}`);
  }
  redirect("/picks");
}
