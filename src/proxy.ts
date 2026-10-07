import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce, supabaseOriginOf } from "@/lib/csp";

// Paths a signed-out visitor may reach. Everything else bounces to sign-in.
const PUBLIC_PATHS = ["/sign-in"];

/**
 * Runs before every page request:
 *
 * 1. Mints a fresh CSP nonce and puts the policy on both the request (so
 *    Next.js stamps the nonce on its scripts while rendering) and the
 *    response (so the browser enforces it).
 * 2. Refreshes the Supabase session cookie and makes the optimistic "are you
 *    signed in at all" redirect. It is deliberately NOT the access check:
 *    whether a member may see paid content is decided by RLS on every query.
 */
export async function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = buildCsp(nonce, {
    dev: process.env.NODE_ENV === "development",
    supabaseOrigin: supabaseOriginOf(process.env.NEXT_PUBLIC_SUPABASE_URL),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  // Headers @supabase/ssr hands over with refreshed auth cookies (no-store
  // and friends): a response carrying one member's session token must never
  // be cached by a CDN and served to someone else.
  const sessionHeaders: Record<string, string> = {};
  const withCsp = <T extends NextResponse>(res: T): T => {
    res.headers.set("Content-Security-Policy", csp);
    for (const [name, value] of Object.entries(sessionHeaders)) res.headers.set(name, value);
    return res;
  };
  const next = () => NextResponse.next({ request: { headers: requestHeaders } });

  let response = next();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return withCsp(response);
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        // Refreshed tokens must reach this render too, not just the browser.
        requestHeaders.set("cookie", request.headers.get("cookie") ?? "");
        response = next();
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.assign(sessionHeaders, headers ?? {});
      },
    },
  });

  // getClaims validates the JWT (and refreshes it when needed). Do not put
  // code between creating the client and this call.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const path = request.nextUrl.pathname;

  if (!signedIn && !PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
    return withCsp(redirectKeepingCookies(request, response, "/sign-in"));
  }

  if (signedIn && path === "/sign-in") {
    return withCsp(redirectKeepingCookies(request, response, "/"));
  }

  return withCsp(response);
}

/** A redirect that carries any session cookies getClaims just refreshed. */
function redirectKeepingCookies(request: NextRequest, from: NextResponse, pathname: string) {
  const to = request.nextUrl.clone();
  to.pathname = pathname;
  to.search = "";
  const redirect = NextResponse.redirect(to);
  for (const cookie of from.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}

export const config = {
  matcher: [
    // Skip static assets, PWA files and every API route. API routes do their
    // own authentication (Paystack signature, cron secret) and must see the
    // request untouched.
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js|offline\\.html|manifest\\.webmanifest|icon|apple-icon|api/).*)",
  ],
};
