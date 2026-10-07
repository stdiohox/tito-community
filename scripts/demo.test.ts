/**
 * Client preview mode safety. These are the guarantees that let a demo be
 * deployed at all:
 *   - it is off unless DEMO_MODE=true;
 *   - it refuses to run if any real service key is present;
 *   - its network refuses every host except its own in-process fakes.
 *
 *   npm run test:demo
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DemoModeRefused, REAL_SERVICE_KEYS, isDemo } from "../src/lib/demo/mode";
import { accessTokenFromCookies, signDemoJwt, verifyDemoJwt } from "../src/lib/demo/token";

const envOf = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("demo mode switch", () => {
  test("off unless DEMO_MODE is exactly 'true'", () => {
    assert.equal(isDemo(envOf({})), false);
    assert.equal(isDemo(envOf({ DEMO_MODE: "1" })), false);
    assert.equal(isDemo(envOf({ DEMO_MODE: "TRUE" })), false);
  });

  test("on with DEMO_MODE=true and no real keys", () => {
    assert.equal(isDemo(envOf({ DEMO_MODE: "true" })), true);
  });

  for (const key of REAL_SERVICE_KEYS) {
    test(`refused when ${key} is set alongside it`, () => {
      assert.throws(() => isDemo(envOf({ DEMO_MODE: "true", [key]: "anything" })), DemoModeRefused);
    });
  }

  test("a real deployment is unaffected by the demo code (no flag, real keys)", () => {
    assert.equal(isDemo(envOf({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" })), false);
  });
});

describe("demo sessions", () => {
  test("tokens round-trip, and a tampered or expired token is rejected", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = signDemoJwt({ sub: "u1", role: "authenticated", aal: "aal1", exp });
    assert.equal(verifyDemoJwt(t)?.sub, "u1");
    const [h, b, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "u1", role: "authenticated", aal: "aal2", exp })).toString("base64url");
    assert.equal(verifyDemoJwt(`${h}.${forged}.${s}`), null, "raising aal without the secret fails");
    assert.equal(verifyDemoJwt(`${h}.${b}.x${s.slice(1)}`), null);
    assert.equal(verifyDemoJwt(signDemoJwt({ sub: "u1", role: "authenticated", exp: 1 })), null, "expired");
  });

  test("the proxy reads the token out of a (chunked, base64) session cookie", () => {
    const token = signDemoJwt({ sub: "u2", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 60 });
    const value = `base64-${Buffer.from(JSON.stringify({ access_token: token })).toString("base64url")}`;
    const half = Math.floor(value.length / 2);
    const cookies = [
      { name: "sb-demo-auth-token.1", value: value.slice(half) },
      { name: "unrelated", value: "x" },
      { name: "sb-demo-auth-token.0", value: value.slice(0, half) },
    ];
    assert.equal(accessTokenFromCookies(cookies), token);
  });
});

describe("demo signatures", () => {
  test("sandbox ids are only valid if this deployment minted them", async () => {
    const { mintSid, verifySid } = await import("../src/lib/demo/token");
    const sid = mintSid();
    assert.match(verifySid(sid) ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(verifySid(sid.slice(0, 36)), null, "a bare uuid (no signature) is refused");
    assert.equal(verifySid(`${crypto.randomUUID()}.${sid.slice(37)}`), null, "a signature cannot be moved to another id");
    assert.equal(verifySid(undefined), null);
  });

  test("a refresh token is never accepted as an access token", async () => {
    const { signDemoJwt, verifyDemoJwt, verifyDemoRefresh } = await import("../src/lib/demo/token");
    const exp = Math.floor(Date.now() / 1000) + 60;
    const refresh = signDemoJwt({ sub: "u", role: "authenticated", exp, typ: "refresh" });
    assert.equal(verifyDemoJwt(refresh), null);
    assert.equal(verifyDemoRefresh(refresh)?.sub, "u");
    const access = signDemoJwt({ sub: "u", role: "authenticated", exp });
    assert.equal(verifyDemoRefresh(access), null);
  });

  test("each signature is bound to its purpose", async () => {
    const { demoMac, macMatches } = await import("../src/lib/demo/token");
    const data = "same-input";
    const asChart = demoMac("chart", data).toString("base64url");
    assert.ok(macMatches("chart", data, asChart));
    for (const other of ["jwt", "sid", "log", "paystack"] as const) assert.ok(!macMatches(other, data, asChart), other);
  });
});

describe("demo network", () => {
  test("every host other than the in-process fakes is refused", async () => {
    process.env.DEMO_MODE = "true";
    const { demoFetch } = await import("../src/lib/demo/fetch");
    for (const url of [
      "https://abcdefgh.supabase.co/rest/v1/picks",
      "https://api.resend.com/emails",
      "https://fcm.googleapis.com/fcm/send/x",
      "https://example.com/",
    ]) {
      await assert.rejects(() => demoFetch(url), /Demo mode blocked an outbound request/, url);
    }
  });
});
