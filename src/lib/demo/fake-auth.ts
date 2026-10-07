import "server-only";
import { randomUUID } from "node:crypto";
import { exec, type Visitor } from "@/lib/demo/db";
import { DEMO_ADMIN_FACTOR_ID } from "@/lib/demo/seed";
import { signDemoJwt, verifyDemoJwt, verifyDemoRefresh } from "@/lib/demo/token";

/*
 * A small GoTrue for the demo, speaking the protocol supabase-js uses, so
 * the app's real sign-in, session and MFA code runs unchanged:
 *
 *   - any 6-digit code signs in an existing member (invite-only still holds:
 *     unknown addresses are refused),
 *   - staff have one verified authenticator; any 6-digit code passes it,
 *   - sessions are HS256 JWTs signed with DEMO_SECRET.
 */

const SESSION_SECONDS = 60 * 60 * 24 * 7;

type UserRow = { id: string; email: string; created_at?: string };

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const authError = (status: number, code: string, message: string) => json(status, { code, error_code: code, msg: message, message });

async function isStaff(v: Visitor, userId: string): Promise<boolean> {
  const r = await exec(v, `select 1 from public.staff where user_id = $1`, [userId], { claims: null, role: null });
  return r.rows.length > 0;
}

async function userJson(v: Visitor, u: UserRow) {
  const staff = await isStaff(v, u.id);
  const now = new Date().toISOString();
  return {
    id: u.id,
    aud: "authenticated",
    role: "authenticated",
    email: u.email,
    email_confirmed_at: now,
    confirmed_at: now,
    last_sign_in_at: now,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
    created_at: u.created_at ?? now,
    updated_at: now,
    is_anonymous: false,
    factors: staff
      ? [{ id: DEMO_ADMIN_FACTOR_ID, friendly_name: "Authenticator (demo)", factor_type: "totp", status: "verified", created_at: now, updated_at: now }]
      : [],
  };
}

/** A session for a user, at the given assurance level. Also used by the persona switcher. */
export async function sessionFor(v: Visitor, u: UserRow, aal: "aal1" | "aal2") {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const sessionId = randomUUID();
  const access_token = signDemoJwt({ sub: u.id, email: u.email, role: "authenticated", aud: "authenticated", aal, exp, session_id: sessionId });
  const refresh_token = signDemoJwt({ sub: u.id, email: u.email, role: "authenticated", aal, exp: exp + SESSION_SECONDS, session_id: sessionId, typ: "refresh" });
  return {
    access_token,
    token_type: "bearer",
    expires_in: SESSION_SECONDS,
    expires_at: exp,
    refresh_token,
    user: await userJson(v, u),
  };
}

export async function findUserByEmail(v: Visitor, email: string): Promise<UserRow | null> {
  const r = await exec<UserRow>(v, `select id, email from auth.users where lower(email) = lower($1)`, [email], { claims: null, role: null });
  return r.rows[0] ?? null;
}

async function findUserById(v: Visitor, id: string): Promise<UserRow | null> {
  const r = await exec<UserRow>(v, `select id, email from auth.users where id = $1`, [id], { claims: null, role: null });
  return r.rows[0] ?? null;
}

export async function handleAuth(v: Visitor, url: URL, init: { method: string; headers: Headers; body: string | null }): Promise<Response> {
  const path = url.pathname.replace(/^.*\/auth\/v1/, "");
  const method = init.method.toUpperCase();
  const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  const bearer = (init.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const claims = verifyDemoJwt(bearer);

  // Who am I.
  if (path === "/user" && method === "GET") {
    if (!claims?.sub) return authError(401, "bad_jwt", "Invalid session");
    const u = await findUserById(v, claims.sub);
    return u ? json(200, await userJson(v, u)) : authError(404, "user_not_found", "User not found");
  }

  // Request a sign-in code. Never says whether the address exists.
  if (path === "/otp" && method === "POST") {
    return json(200, {});
  }

  // Check a sign-in code: any 6 to 10 digits, for an existing member.
  if (path === "/verify" && method === "POST") {
    const email = String(body.email ?? "");
    const token = String(body.token ?? "");
    const u = await findUserByEmail(v, email);
    if (!u || !/^\d{6,10}$/.test(token)) return authError(403, "otp_expired", "Token has expired or is invalid");
    return json(200, await sessionFor(v, u, "aal1"));
  }

  if (path === "/token" && url.searchParams.get("grant_type") === "refresh_token" && method === "POST") {
    const rc = verifyDemoRefresh(String(body.refresh_token ?? ""));
    if (!rc?.sub) return authError(400, "refresh_token_not_found", "Invalid Refresh Token");
    const u = await findUserById(v, rc.sub);
    if (!u) return authError(400, "user_not_found", "User not found");
    return json(200, await sessionFor(v, u, rc.aal === "aal2" ? "aal2" : "aal1"));
  }

  if (path === "/logout" && method === "POST") {
    return new Response(null, { status: 204 });
  }

  // MFA: challenge, then verify with any 6-digit code.
  const factor = path.match(/^\/factors\/([0-9a-f-]{36})\/(challenge|verify)$/);
  if (factor && method === "POST") {
    if (!claims?.sub) return authError(401, "bad_jwt", "Invalid session");
    if (factor[1] !== DEMO_ADMIN_FACTOR_ID || !(await isStaff(v, claims.sub))) {
      return authError(404, "mfa_factor_not_found", "Factor not found");
    }
    if (factor[2] === "challenge") {
      return json(200, { id: randomUUID(), type: "totp", expires_at: Math.floor(Date.now() / 1000) + 300 });
    }
    if (!/^\d{6}$/.test(String(body.code ?? ""))) return authError(422, "mfa_verification_failed", "Invalid TOTP code entered");
    const u = await findUserById(v, claims.sub);
    return u ? json(200, await sessionFor(v, u, "aal2")) : authError(404, "user_not_found", "User not found");
  }
  if (path === "/factors" && method === "POST") {
    return authError(422, "mfa_enroll_not_enabled", "Authenticator set-up is not part of the demo");
  }

  // Admin: create a user (member invites). Service role only.
  if (path === "/admin/users" && method === "POST") {
    if (claims?.role !== "service_role") return authError(403, "not_admin", "User not allowed");
    const email = String(body.email ?? "").toLowerCase();
    if (await findUserByEmail(v, email)) return authError(422, "email_exists", "A user with this email address has already been registered");
    const res = await exec<UserRow>(v, `insert into auth.users (id, email) values ($1, $2) returning id, email`, [randomUUID(), email], {
      claims: null,
      role: null,
      persistRowsOf: "auth.users",
    });
    return json(200, await userJson(v, res.rows[0]));
  }

  return authError(404, "not_found", `Demo auth does not implement ${method} ${path}`);
}
