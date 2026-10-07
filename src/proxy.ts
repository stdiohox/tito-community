import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Paths a signed-out visitor may reach. Everything else bounces to sign-in.
const PUBLIC_PATHS = ["/sign-in"];

/**
 * Refreshes the Supabase session cookie on every request and makes the
 * optimistic "are you signed in at all" redirect. It is deliberately NOT the
 * access check: whether a member may see paid content is decided by RLS on
 * every query, and by the server-side layout guards for the UX.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return response;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getClaims validates the JWT (and refreshes it when needed). Do not put
  // code between creating the client and this call.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const path = request.nextUrl.pathname;

  if (!signedIn && !PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
    return redirectKeepingCookies(request, response, "/sign-in");
  }

  if (signedIn && path === "/sign-in") {
    return redirectKeepingCookies(request, response, "/");
  }

  return response;
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
    // Skip static assets, PWA files and the Paystack webhook (which must see
    // the raw, untouched request and has its own signature check).
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js|offline\\.html|manifest\\.webmanifest|icon|apple-icon|api/paystack/webhook).*)",
  ],
};
