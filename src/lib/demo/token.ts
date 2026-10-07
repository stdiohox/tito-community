import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { demoSecret } from "@/lib/demo/mode";

/*
 * Everything the demo signs, all keyed by DEMO_SECRET with a distinct
 * purpose prefix per use (sessions, sandbox ids, the state cookie, chart
 * links, the simulated Paystack key), so a signature made for one purpose
 * can never be passed off as another.
 */

export type DemoPurpose = "jwt" | "sid" | "log" | "chart" | "paystack";

export function demoMac(purpose: DemoPurpose, data: string): Buffer {
  return createHmac("sha256", demoSecret()).update(`${purpose}|${data}`).digest();
}

export function macMatches(purpose: DemoPurpose, data: string, given: string): boolean {
  const expected = demoMac(purpose, data);
  const g = Buffer.from(given, "base64url");
  return g.length === expected.length && timingSafeEqual(g, expected);
}

// ---------------------------------------------------------------------------
// Sandbox ids: minted only by the proxy, so a request cannot conjure a new
// sandbox (and a new database) by inventing an id.
// ---------------------------------------------------------------------------
export function mintSid(): string {
  const id = randomUUID();
  return `${id}.${demoMac("sid", id).toString("base64url")}`;
}

/** The sandbox id inside a signed value, or null if it is not one we minted. */
export function verifySid(value: string | undefined | null): string | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot !== 36) return null;
  const id = value.slice(0, dot);
  return /^[0-9a-f-]{36}$/.test(id) && macMatches("sid", id, value.slice(dot + 1)) ? id : null;
}

// ---------------------------------------------------------------------------
// Sessions: HS256 JWTs in Supabase's shape, so the app's real auth code
// (getClaims, aal checks, RLS on auth.jwt()) runs unchanged.
// ---------------------------------------------------------------------------
const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export type DemoClaims = {
  sub?: string;
  email?: string;
  role: "anon" | "authenticated" | "service_role";
  aal?: "aal1" | "aal2";
  aud?: string;
  exp: number;
  session_id?: string;
  /** Refresh tokens are marked, and never accepted as access tokens. */
  typ?: "refresh";
};

export function signDemoJwt(claims: DemoClaims): string {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(claims));
  return `${head}.${body}.${demoMac("jwt", `${head}.${body}`).toString("base64url")}`;
}

function verifyAny(token: string | null | undefined): DemoClaims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  if (!macMatches("jwt", `${parts[0]}.${parts[1]}`, parts[2])) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as DemoClaims;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Verified access-token claims, or null if malformed, forged, expired or a refresh token. */
export function verifyDemoJwt(token: string | null | undefined): DemoClaims | null {
  const c = verifyAny(token);
  return c && c.typ !== "refresh" ? c : null;
}

/** Verified refresh-token claims only. */
export function verifyDemoRefresh(token: string | null | undefined): DemoClaims | null {
  const c = verifyAny(token);
  return c && c.typ === "refresh" ? c : null;
}

/** Long-lived keys standing in for the anon and service-role keys. */
export function demoAnonKey(): string {
  return signDemoJwt({ role: "anon", exp: 4102444800 });
}
export function demoServiceKey(): string {
  return signDemoJwt({ role: "service_role", exp: 4102444800 });
}

/** The simulated Paystack secret: secret itself, so nobody else can sign demo webhooks. */
export function demoPaystackKey(): string {
  return `sk_demo_${demoMac("paystack", "webhook-signing-key").toString("hex")}`;
}

/**
 * The access token inside a @supabase/ssr session cookie (possibly split
 * into numbered chunks, possibly "base64-" encoded), for the proxy, which
 * decides "signed in or not" without any network call.
 */
export function accessTokenFromCookies(cookies: { name: string; value: string }[]): string | null {
  const parts = cookies
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => {
      const n = (s: string) => Number(s.match(/\.(\d+)$/)?.[1] ?? -1);
      return n(a.name) - n(b.name);
    });
  if (parts.length === 0) return null;
  let raw = parts.map((p) => p.value).join("");
  if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice(7), "base64url").toString();
  try {
    return (JSON.parse(raw) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}
