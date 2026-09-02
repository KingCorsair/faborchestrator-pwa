/**
 * WP2 — where the FabOrchestrator token lives, and how it stops living there.
 *
 * The property under test is the one the whole design rests on: **the FO token
 * never reaches client JavaScript.** It is a real session against a real
 * FabOrchestrator carrying an operator's role, data connections, quota and
 * audit trail, so a copy of it in `localStorage` or a readable cookie is not a
 * demo shortcut, it is a credential leak that survives screenshots and
 * service-worker caches.
 *
 * FO expires that token on two independent clocks, which is why eviction is
 * tested rather than assumed:
 *   - a 30-day absolute expiry set at login, and
 *   - a 30-minute idle timeout that DELETES the session server-side
 *     (`claudeai_athena/lib/session-audit.ts`, IDLE_TIMEOUT_MS).
 * The second one is the demo-killer: a token that worked at the start of a
 * meeting is gone by the end of it, and the app must recover by asking for a
 * sign-in rather than failing identically on every retry.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Needed to mint a session below. Read lazily inside `sessionFor`, so setting
// it before the imports run is not required — but it must be set before any
// test calls it.
process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";

import { NextRequest, NextResponse } from "next/server";

import { foFingerprint, sessionFor, verifyToken } from "@/lib/auth";
import {
  FO_TOKEN_COOKIE,
  setFoTokenCookie,
  clearFoTokenCookie,
  foTokenFrom,
} from "@/lib/faborch/session";

const TOKEN = "fo-session-6f1c8b2e-not-a-real-token";
const IN_30_DAYS = new Date(Date.now() + 30 * 864e5).toISOString();

const reqWith = (headers: Record<string, string> = {}, url = "http://localhost:3002/x") =>
  new NextRequest(url, { headers });

/** The Set-Cookie line the browser would actually receive. */
const setCookieOf = (res: NextResponse): string => res.headers.get("set-cookie") ?? "";

describe("the token is written as an httpOnly cookie", () => {
  test("httpOnly is set, so document.cookie cannot read it", () => {
    const res = NextResponse.json({ ok: true });
    setFoTokenCookie(reqWith(), res, TOKEN, IN_30_DAYS);
    assert.match(setCookieOf(res), /HttpOnly/i);
  });

  test("the value is the token, scoped to the whole app", () => {
    const res = NextResponse.json({ ok: true });
    setFoTokenCookie(reqWith(), res, TOKEN, IN_30_DAYS);
    const line = setCookieOf(res);
    assert.ok(line.startsWith(`${FO_TOKEN_COOKIE}=${TOKEN}`), line);
    assert.match(line, /Path=\//);
  });

  test("SameSite=Lax, so another origin cannot drive the proxy with it", () => {
    const res = NextResponse.json({ ok: true });
    setFoTokenCookie(reqWith(), res, TOKEN, IN_30_DAYS);
    assert.match(setCookieOf(res), /SameSite=lax/i);
  });

  test("the cookie expiry follows FO's own, so it cannot outlive the session", () => {
    const res = NextResponse.json({ ok: true });
    setFoTokenCookie(reqWith(), res, TOKEN, IN_30_DAYS);
    const line = setCookieOf(res);
    assert.match(line, /Expires=/i);
    const expires = new Date(line.match(/Expires=([^;]+)/i)![1]!);
    // within a minute of what FO said
    assert.ok(Math.abs(expires.getTime() - new Date(IN_30_DAYS).getTime()) < 60_000, line);
  });

  test("an unparseable expiry produces a session cookie rather than a bad date", () => {
    const res = NextResponse.json({ ok: true });
    setFoTokenCookie(reqWith(), res, TOKEN, "not a date");
    const line = setCookieOf(res);
    assert.ok(!/Invalid Date/i.test(line), line);
  });
});

describe("Secure follows the scheme, not NODE_ENV", () => {
  // The recorded defect: `npm start` on http://localhost sets NODE_ENV
  // production, so keying Secure off NODE_ENV marks the cookie Secure on a
  // plain-HTTP origin. Safari may then drop it silently and every turn reports
  // "not signed in to FabOrchestrator".
  test("plain http localhost does not get Secure", () => {
    const res = NextResponse.json({ ok: true });
    setFoTokenCookie(reqWith({}, "http://localhost:3002/x"), res, TOKEN, IN_30_DAYS);
    assert.ok(!/Secure/i.test(setCookieOf(res)), setCookieOf(res));
  });

  test("x-forwarded-proto=https gets Secure, which is the deployed case", () => {
    const res = NextResponse.json({ ok: true });
    setFoTokenCookie(reqWith({ "x-forwarded-proto": "https" }), res, TOKEN, IN_30_DAYS);
    assert.match(setCookieOf(res), /Secure/i);
  });

  test("a comma-joined forwarded chain reads the first hop", () => {
    const res = NextResponse.json({ ok: true });
    setFoTokenCookie(reqWith({ "x-forwarded-proto": "https,http" }), res, TOKEN, IN_30_DAYS);
    assert.match(setCookieOf(res), /Secure/i);
  });

  test("a direct https request gets Secure with no proxy header", () => {
    const res = NextResponse.json({ ok: true });
    setFoTokenCookie(reqWith({}, "https://faborch-demo.fly.dev/x"), res, TOKEN, IN_30_DAYS);
    assert.match(setCookieOf(res), /Secure/i);
  });
});

describe("reading it back", () => {
  test("the proxy can read the token it set", () => {
    assert.equal(foTokenFrom(reqWith({ cookie: `${FO_TOKEN_COOKIE}=${TOKEN}` })), TOKEN);
  });

  test("no cookie reads as null, not as an empty string", () => {
    assert.equal(foTokenFrom(reqWith()), null);
  });

  test("an empty cookie value reads as null, so it cannot be sent as a token", () => {
    assert.equal(foTokenFrom(reqWith({ cookie: `${FO_TOKEN_COOKIE}=` })), null);
  });

  test("this app's own session cookie is not mistaken for the FO one", () => {
    assert.equal(foTokenFrom(reqWith({ cookie: "session=abc; other=def" })), null);
  });
});

describe("clearing it — the idle-eviction and sign-out path", () => {
  test("clearing expires the cookie immediately", () => {
    const res = NextResponse.json({ ok: true });
    clearFoTokenCookie(res);
    const line = setCookieOf(res);
    assert.match(line, new RegExp(`^${FO_TOKEN_COOKIE}=;`));
    assert.match(line, /Max-Age=0/i);
  });

  test("the cleared cookie carries no token value", () => {
    const res = NextResponse.json({ ok: true });
    setFoTokenCookie(reqWith(), res, TOKEN, IN_30_DAYS);
    clearFoTokenCookie(res);
    assert.ok(!setCookieOf(res).includes(TOKEN), setCookieOf(res));
  });

  test("it clears on the same path it was set on, or the browser keeps it", () => {
    const res = NextResponse.json({ ok: true });
    clearFoTokenCookie(res);
    assert.match(setCookieOf(res), /Path=\//);
  });
});

describe("the token never appears in a response body", () => {
  // A body is readable by client JavaScript; the cookie is not. This asserts
  // the login route's contract at the shape level: whatever it returns, the
  // token is only ever in the header.
  test("a login-shaped response body carries no token", () => {
    const body = { token: "pwa-hmac-session", user: { email: "a@b.c" }, faborch: true };
    const res = NextResponse.json(body);
    setFoTokenCookie(reqWith(), res, TOKEN, IN_30_DAYS);
    assert.ok(!JSON.stringify(body).includes(TOKEN));
    assert.ok(setCookieOf(res).includes(TOKEN)); // header only
  });
});

describe("sign-out revokes, without a session store", () => {
  // The WP2 acceptance line is "sign-out revokes". The plan expected that to
  // need a database: a server-side session row to delete. It does not. The
  // bearer token carries a fingerprint of the FabOrchestrator token it was
  // minted beside, and `requireAuth` refuses any request whose cookie does not
  // match — so deleting the cookie, which is all sign-out can do, leaves the
  // token authenticating nothing.
  test("a token is worthless once its FabOrchestrator cookie is gone", () => {
    const minted = sessionFor(
      { id: "u1", email: "a@b.c", name: "A", roleName: "Supervisor" },
      IN_30_DAYS,
      TOKEN,
    );
    const payload = verifyToken(minted.token);
    assert.ok(payload, "the token itself is still well-formed and unexpired");

    // What requireAuth checks: the fingerprint against the cookie on the request.
    assert.equal(payload!.fp, foFingerprint(TOKEN), "matches its own FO token");
    assert.notEqual(payload!.fp, foFingerprint("some-other-token"), "and no other");
  });

  test("the fingerprint is one-way — the FO token is not recoverable from it", () => {
    const minted = sessionFor(
      { id: "u1", email: "a@b.c", name: "A", roleName: "Supervisor" },
      IN_30_DAYS,
      TOKEN,
    );
    // The payload is base64, not encryption: anyone holding the token can read
    // it, so it must not contain the FO token.
    const body = Buffer.from(minted.token.split(".")[0]!, "base64url").toString("utf8");
    assert.ok(!body.includes(TOKEN), "the FO token must not appear in the payload");
    assert.ok(body.includes(foFingerprint(TOKEN)), "only its fingerprint does");
  });

  test("two sessions for the same person against different FO tokens do not interchange", () => {
    const user = { id: "u1", email: "a@b.c", name: "A", roleName: "Supervisor" } as const;
    const a = verifyToken(sessionFor({ ...user }, IN_30_DAYS, "fo-token-A").token)!;
    const b = verifyToken(sessionFor({ ...user }, IN_30_DAYS, "fo-token-B").token)!;
    assert.notEqual(a.fp, b.fp);
  });
});
