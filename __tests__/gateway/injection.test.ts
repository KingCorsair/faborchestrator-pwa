/**
 * The single-login bridge (`lib/gateway/auth-bridge.ts`), WP2.
 *
 * The property under test is the one that makes one login safe: a request is
 * given FabOrchestrator's token **only** when it proves a live session of this
 * app *and* carries the FabOrchestrator cookie that session was minted beside.
 * Either half alone buys nothing. That is what makes signing out a revocation
 * without a server-side session store, and it is why a bearer copied off a
 * device is inert.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL ??= "https://fo.test";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { bridgeAuthorization, endsTheSession, expiredUpstream } from "@/lib/gateway/auth-bridge";

const ORIGIN = "https://faborch-demo.fly.dev";
const FO_TOKEN = "fo-session-not-a-real-token";
const OTHER_FO_TOKEN = "a-different-fo-session-token";

const USER = {
  id: "u1",
  email: "supervisor@athenatech.example",
  name: "A. Supervisor",
  roleName: "Supervisor",
};

const far = new Date(Date.now() + 30 * 864e5).toISOString();
/** The bearer this app hands to `localStorage`, bound to `FO_TOKEN`. */
const PWA_TOKEN = sessionFor(USER, far, FO_TOKEN).token;
/** A session of this app minted beside a *different* FabOrchestrator token. */
const PWA_TOKEN_OTHER = sessionFor(USER, far, OTHER_FO_TOKEN).token;

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest(new URL("/api/mcp/connections", ORIGIN), { headers });
}

describe("what FabOrchestrator is told to trust", () => {
  test("a live session with its own cookie gets the real token", () => {
    const verdict = bridgeAuthorization(
      request({ authorization: `Bearer ${PWA_TOKEN}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` }),
    );
    assert.equal(verdict.action, "inject");
    assert.equal(verdict.action === "inject" && verdict.foToken, FO_TOKEN);
    assert.equal(verdict.action === "inject" && verdict.userId, "u1", "the verified session's user");
  });

  test("no bearer at all is forwarded anonymously — FabOrchestrator answers for itself", () => {
    // `/api/platform-theme` is fetched by FO's root layout before anyone signs
    // in. Refusing it here would break the page for a signed-out visitor.
    assert.equal(bridgeAuthorization(request({})).action, "forward-anonymous");
    assert.equal(
      bridgeAuthorization(request({ cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` })).action,
      "forward-anonymous",
    );
  });
});

describe("what is refused, and never forwarded", () => {
  test("a bearer with no cookie — the sign-out case", () => {
    // Signing out drops the cookie. The bearer left in `localStorage` must buy
    // its holder nothing at all.
    const verdict = bridgeAuthorization(request({ authorization: `Bearer ${PWA_TOKEN}` }));
    assert.equal(verdict.action, "refuse");
  });

  test("a bearer with an emptied cookie, which is what sign-out leaves behind", () => {
    const verdict = bridgeAuthorization(
      request({ authorization: `Bearer ${PWA_TOKEN}`, cookie: `${FO_TOKEN_COOKIE}=` }),
    );
    assert.equal(verdict.action, "refuse");
  });

  test("a session minted beside a different FabOrchestrator token", () => {
    // The fingerprint check. A stolen bearer cannot be paired with somebody
    // else's cookie to reach FabOrchestrator.
    const verdict = bridgeAuthorization(
      request({ authorization: `Bearer ${PWA_TOKEN_OTHER}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` }),
    );
    assert.equal(verdict.action, "refuse");
  });

  test("a forged, malformed or expired bearer", () => {
    const expired = sessionFor(USER, new Date(Date.now() - 1000).toISOString(), FO_TOKEN).token;
    for (const value of ["Bearer nonsense", "Bearer ", `Bearer ${expired}`]) {
      const verdict = bridgeAuthorization(
        request({ authorization: value, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` }),
      );
      assert.equal(verdict.action, "refuse", value);
    }
  });

  test("an authorization scheme that is not Bearer", () => {
    const verdict = bridgeAuthorization(
      request({ authorization: `Basic ${PWA_TOKEN}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` }),
    );
    assert.equal(verdict.action, "refuse");
  });

  test("a refusal never names which half was wrong", () => {
    // Saying which of the three it was tells an attacker which to work on —
    // the same rule `lib/auth-middleware.ts` follows.
    const noCookie = bridgeAuthorization(request({ authorization: `Bearer ${PWA_TOKEN}` }));
    const forged = bridgeAuthorization(
      request({ authorization: "Bearer nonsense", cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` }),
    );
    assert.equal(noCookie.action, "refuse");
    assert.equal(forged.action, "refuse");
    assert.equal(
      noCookie.action === "refuse" && noCookie.reason,
      forged.action === "refuse" && forged.reason,
    );
  });
});

describe("which refusals end a session (plan RP2, G5)", () => {
  // A real session that has ended carries the cookie's FO token, so the
  // gateway can clear the cookie and revoke that token. A malformed bearer, or
  // one with no cookie beside it, ends nothing.
  const refuse = (headers: Record<string, string>) => {
    const verdict = bridgeAuthorization(request(headers));
    assert.equal(verdict.action, "refuse");
    return verdict.action === "refuse" ? verdict.endSession : undefined;
  };

  test("an expired bearer beside its cookie: the cookie's token is to be revoked", () => {
    const expired = sessionFor(USER, new Date(Date.now() - 1000).toISOString(), FO_TOKEN).token;
    assert.deepEqual(refuse({ authorization: `Bearer ${expired}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` }), {
      foToken: FO_TOKEN,
    });
  });

  test("a bearer paired with a cookie that is not its own: that cookie's token", () => {
    assert.deepEqual(
      refuse({ authorization: `Bearer ${PWA_TOKEN_OTHER}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` }),
      { foToken: FO_TOKEN },
    );
  });

  test("a malformed bearer, or no cookie at all, ends nothing", () => {
    assert.equal(refuse({ authorization: "Bearer nonsense", cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` }), null);
    assert.equal(refuse({ authorization: `Basic ${PWA_TOKEN}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` }), null);
    assert.equal(refuse({ authorization: `Bearer ${PWA_TOKEN}` }), null);
  });
});

describe("when FabOrchestrator's answer ends this app's session too", () => {
  test("signing out through FabOrchestrator's own endpoint drops the cookie", () => {
    assert.equal(endsTheSession("/api/auth/logout", 200), true);
    assert.equal(endsTheSession("/api/auth/logout", 204), true);
    // 404 means FabOrchestrator had already dropped it. Same outcome asked for.
    assert.equal(endsTheSession("/api/auth/logout", 404), true);
  });

  test("a failed sign-out leaves the session alone", () => {
    assert.equal(endsTheSession("/api/auth/logout", 500), false);
  });

  test("no other path ends the session", () => {
    for (const p of ["/api/chat", "/api/auth/me", "/api/conversations", "/chat"]) {
      assert.equal(endsTheSession(p, 200), false, p);
    }
  });

  test("an upstream 401 on an injected request means the token is dead", () => {
    // FabOrchestrator evicts after 30 minutes idle. Keeping the cookie would
    // leave the operator holding a session that passes this app's gate and
    // cannot answer a question.
    assert.equal(expiredUpstream(true, 401), true);
  });

  test("a 401 on a request that was never injected says nothing about our cookie", () => {
    assert.equal(expiredUpstream(false, 401), false);
  });

  test("any other status leaves the cookie alone", () => {
    for (const s of [200, 403, 404, 500, 502]) {
      assert.equal(expiredUpstream(true, s), false, String(s));
    }
  });
});
