import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Whether this staff member may enrol an authenticator right now. Lives
 * outside the "use server" actions file on purpose: exported from there it
 * would become a public endpoint.
 */
export async function enrollmentOpen(userId: string): Promise<boolean> {
  const { data, error } = await createServiceClient()
    .from("staff")
    .select("mfa_enrollment_open")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Could not read enrolment state: ${error.message}`);
  return data?.mfa_enrollment_open === true;
}
