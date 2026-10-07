/**
 * The page Content-Security-Policy, built per request around a fresh nonce.
 *
 * Scripts: only those carrying this request's nonce run ('strict-dynamic'
 * then trusts what they load). Next.js reads the nonce from the request's
 * CSP header and stamps it on its own scripts, so no 'unsafe-inline' is
 * needed. Development adds 'unsafe-eval', which React uses for debug stacks;
 * production never has it.
 *
 * Styles keep 'unsafe-inline' deliberately: the UI sets per-element style
 * attributes (stagger delays), which nonces cannot cover. Style injection is
 * a far smaller risk than script injection, and the finding was scripts.
 */
export function buildCsp(nonce: string, opts: { dev: boolean; supabaseOrigin: string }): string {
  const supabase = opts.supabaseOrigin ? ` ${opts.supabaseOrigin}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${supabase}`,
    "font-src 'self'",
    `connect-src 'self'${supabase}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // Checkout and "manage auto-renew" are server redirects to Paystack after
    // a form post; Chrome applies form-action to that redirect.
    "form-action 'self' https://checkout.paystack.com https://paystack.com https://*.paystack.com",
    "object-src 'none'",
  ].join("; ");
}

/** 128 random bits, base64. Unpredictable and unique per request. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export function supabaseOriginOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").origin;
  } catch {
    return "";
  }
}
