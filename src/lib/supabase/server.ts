import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { isDemo } from "@/lib/demo/mode";

/**
 * The member's own client. Every read of paid content goes through this one,
 * so Postgres RLS decides what comes back, not app code.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(env.supabaseUrl(), env.supabaseAnonKey(), {
    ...demoTransport(),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // proxy refreshes the session on the next request, so this is safe.
        }
      },
    },
  });
}

/**
 * Service role: bypasses RLS. Used only for the Paystack webhook and return
 * check, member invites, checkout intents and notification fan-out. Never
 * imported by a client component ("server-only" enforces that at build time).
 */
export function createServiceClient() {
  return createSupabaseClient(env.supabaseUrl(), env.supabaseServiceRoleKey(), {
    ...demoTransport(),
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * In client preview mode, both clients talk to the in-process demo
 * (src/lib/demo/fetch.ts), which refuses every other host. Loaded lazily so
 * a real deployment never loads the demo database engine.
 */
function demoTransport() {
  if (!isDemo()) return {};
  return {
    global: {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { demoFetch } = await import("@/lib/demo/fetch");
        return demoFetch(input, init);
      }) as typeof fetch,
    },
  };
}
