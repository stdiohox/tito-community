import "server-only";
import { currentVisitor } from "@/lib/demo/db";
import { handleAuth } from "@/lib/demo/fake-auth";
import { handleRest } from "@/lib/demo/fake-rest";
import { handlePaystack, handleStorage } from "@/lib/demo/fake-services";
import { demoSupabaseUrl } from "@/lib/demo/mode";
import { verifyDemoJwt } from "@/lib/demo/token";

/**
 * The only network the app has in demo mode. Supabase (REST, Auth,
 * Storage) and Paystack calls are answered in-process from the visitor's
 * private sample database. ANY other destination is refused: there is no
 * code path by which a demo request reaches a real service.
 */
export async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const supabase = new URL(demoSupabaseUrl());

  const isSupabase = url.origin === supabase.origin && url.pathname.startsWith(supabase.pathname + "/");
  const isPaystack = url.origin === "https://api.paystack.co";
  if (!isSupabase && !isPaystack) {
    throw new Error(`Demo mode blocked an outbound request to ${url.origin}. The demo never contacts real services.`);
  }

  const body = req.method === "GET" || req.method === "HEAD" ? null : await req.clone().text();
  const visitor = await currentVisitor();

  if (isPaystack) return handlePaystack(visitor, url, { method: req.method, body });

  const sub = url.pathname.slice(supabase.pathname.length);
  if (sub.startsWith("/auth/v1/")) return handleAuth(visitor, url, { method: req.method, headers: req.headers, body });

  // REST and Storage act as whoever the bearer token says, exactly like
  // Supabase: anon, a signed-in member (with aal), or the service role.
  const claims = verifyDemoJwt((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
  if (!claims) {
    return new Response(JSON.stringify({ code: "PGRST301", message: "JWT invalid or expired" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const auth = { role: claims.role, claims: { ...claims } };

  if (sub.startsWith("/rest/v1/")) return handleRest(visitor, url, { method: req.method, headers: req.headers, body }, auth);
  if (sub.startsWith("/storage/v1/")) {
    return handleStorage(visitor, url, { method: req.method, headers: req.headers, body, raw: req }, auth);
  }
  return new Response(JSON.stringify({ message: `Demo has no service at ${sub}` }), { status: 404 });
}
