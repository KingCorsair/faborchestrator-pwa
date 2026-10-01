/**
 * The device key and its seat: several people sharing one FabOrchestrator
 * account, each device its own private session (`lib/faborch/device.ts`,
 * 1 October 2026).
 *
 * The gateway separates devices by the seat in the signed session
 * (`lib/gateway/seats.ts`). What sign-in owes it is a stable, unguessable name
 * for the device **that nobody else can choose**, signed into the session and
 * told to nobody. These pin exactly that: a first sign-in mints a key; the same
 * browser gets the same seat again; two browsers get different seats; a planted
 * or duplicated cookie is never adopted; the key never reaches client
 * JavaScript or FabOrchestrator, and is never lost to a sign-out.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";

import { NextRequest } from "next/server";
import { inspectToken, sessionFor, verifyToken } from "@/lib/auth";
import {
  DEVICE_COOKIE,
  DEVICE_COOKIE_INSECURE,
  deviceKeyFrom,
  newDeviceKey,
  seatIdFor,
} from "@/lib/faborch/device";
import { resetRecentRevokes } from "@/lib/faborch/end-session";
import { POST } from "@/app/api/pwa/auth/login/route";
import { POST as LOGOUT } from "@/app/api/pwa/auth/logout/route";

const realFetch = globalThis.fetch;
const realConsoleError = console.error;

/** What FabOrchestrator's login was sent, one entry per sign-in. */
let loginBodies: Array<Record<string, unknown>> = [];
let foAccepts = true;
let tokens = 0;

beforeEach(() => {
  loginBodies = [];
  foAccepts = true;
  resetRecentRevokes();
  process.env.FABORCH_BASE_URL = "https://fo.test";
  process.env.FO_EMBED_MODE = "whole";
  console.error = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth/login") {
      loginBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (!foAccepts) return Response.json({ error: "Incorrect password" }, { status: 401 });
      tokens += 1;
      return Response.json({
        token: `fo-session-token-${tokens}`,
        expiresAt: new Date(Date.now() + 864e5).toISOString(),
        user: { id: "fo-user-1", email: "shared@plant.example", name: "Shared Account" },
      });
    }
    if (path === "/api/auth/me") {
      return Response.json({ user: { id: "fo-user-1", role: { id: "r1", name: "Operator" } } });
    }
    if (path === "/api/auth/logout") return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

let n = 0;
/** One sign-in with the shared account, from a browser holding `cookie`. */
function signIn(cookie = "", origin = "https://pwa.test", extra: Record<string, string> = {}) {
  n += 1;
  return POST(
    new NextRequest(`${origin}/api/pwa/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "fly-client-ip": `10.9.0.${n}`,
        ...(cookie ? { cookie } : {}),
        ...extra,
      },
      body: JSON.stringify({ email: "shared@plant.example", password: "the-shared-password" }),
    }),
  );
}

/** The `Set-Cookie` line for the device key, or undefined. */
const deviceSetCookie = (res: Response, name = DEVICE_COOKIE) =>
  (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`));
const valueOf = (setCookie: string) => setCookie.split(";")[0]!.split("=").slice(1).join("=");
const keyFrom = (cookie: string, origin = "https://pwa.test", headers: Record<string, string> = {}) =>
  deviceKeyFrom(new NextRequest(`${origin}/api/pwa/auth/login`, { headers: { cookie, ...headers } }));
/** The seat signed into the session a sign-in answered with. */
async function seatOf(res: Response): Promise<{ seat: string | undefined; body: string }> {
  const text = await res.text();
  const token = (JSON.parse(text) as { token: string }).token;
  return { seat: verifyToken(token)?.sid, body: text };
}

describe("a device key", () => {
  test("is 32 random bytes, and no two are the same", () => {
    const a = newDeviceKey();
    const b = newDeviceKey();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
  });

  test("its seat is a stable one-way name: never the key itself", () => {
    const key = newDeviceKey();
    const seat = seatIdFor(key);
    assert.match(seat, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(seatIdFor(key), seat);
    assert.notEqual(seat, key);
    assert.notEqual(seatIdFor(newDeviceKey()), seat);
  });

  test("a cookie that is not one of ours is treated as absent", () => {
    assert.equal(keyFrom(`${DEVICE_COOKIE}=short`), null);
    assert.equal(keyFrom(`${DEVICE_COOKIE}=${"a".repeat(44)}`), null);
    assert.equal(keyFrom(`${DEVICE_COOKIE}=${"a".repeat(42)}!`), null);
    const key = newDeviceKey();
    assert.equal(keyFrom(`other=1; ${DEVICE_COOKIE}=${key}; faborch_token=t`), key);
  });

  test("two cookies of the name are treated as none: which of two is never guessed", () => {
    const real = newDeviceKey();
    const planted = newDeviceKey();
    assert.equal(keyFrom(`${DEVICE_COOKIE}=${real}; ${DEVICE_COOKIE}=${planted}`), null);
    assert.equal(keyFrom(`${DEVICE_COOKIE}=${planted}; x=1; ${DEVICE_COOKIE}=${real}`), null);
  });

  test("on a deployment only the __Host- cookie is read; the plain name is for loopback http alone", () => {
    const key = newDeviceKey();
    assert.equal(DEVICE_COOKIE, "__Host-faborch_seat");
    assert.equal(keyFrom(`${DEVICE_COOKIE_INSECURE}=${key}`), null, "a plain-named cookie is ignored on a deployment");
    assert.equal(keyFrom(`${DEVICE_COOKIE_INSECURE}=${key}`, "http://localhost:3002"), key);
    assert.equal(keyFrom(`${DEVICE_COOKIE}=${key}`, "http://localhost:3002"), null);
  });

  test("a forwarded scheme or host cannot choose the name on a deployment", () => {
    const real = newDeviceKey();
    const planted = newDeviceKey();
    const spoof = { host: "pwa.test", "x-forwarded-proto": "http" };
    assert.equal(keyFrom(`${DEVICE_COOKIE_INSECURE}=${planted}`, "https://pwa.test", spoof), null);
    assert.equal(keyFrom(`${DEVICE_COOKIE_INSECURE}=${planted}; ${DEVICE_COOKIE}=${real}`, "https://pwa.test", spoof), real);
    assert.equal(
      keyFrom(`${DEVICE_COOKIE_INSECURE}=${planted}`, "https://pwa.test", { ...spoof, "x-forwarded-host": "localhost" }),
      null,
      "nor does a forwarded host make it loopback",
    );
  });

  test("it is not the login limiter's device-trust cookie (plan RP3 part 4)", () => {
    assert.notEqual(DEVICE_COOKIE, "faborch_device");
    assert.notEqual(DEVICE_COOKIE_INSECURE, "faborch_device");
  });
});

describe("sign-in gives the session its seat", () => {
  test("a first sign-in mints a key, keeps it in an unshadowable httpOnly cookie, and signs its seat into the session", async () => {
    const res = await signIn();
    assert.equal(res.status, 200);

    const cookie = deviceSetCookie(res)!;
    assert.ok(cookie, "the device cookie is set");
    const key = valueOf(cookie);
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=lax/i);
    assert.match(cookie, /Path=\/(;|$)/, "__Host- requires Path=/");
    assert.doesNotMatch(cookie, /Domain=/i, "__Host- forbids Domain");
    assert.match(cookie, /Max-Age=34560000/, "400 days");

    const { seat, body } = await seatOf(res);
    assert.equal(seat, seatIdFor(key), "the session carries the hash of the key in the cookie");
    assert.ok(!body.includes(key), "the key never reaches client JavaScript");
  });

  test("nothing about the device is sent to FabOrchestrator", async () => {
    const res = await signIn();
    const key = valueOf(deviceSetCookie(res)!);
    assert.deepEqual(Object.keys(loginBodies[0]!).sort(), ["email", "password"]);
    assert.ok(!JSON.stringify(loginBodies[0]).includes(key));
    assert.ok(!JSON.stringify(loginBodies[0]).includes(seatIdFor(key)));
  });

  test("the same browser gets the same seat at its next sign-in", async () => {
    const first = await signIn();
    const cookie = deviceSetCookie(first)!.split(";")[0]!;
    const second = await signIn(cookie);
    assert.equal(second.status, 200);
    assert.equal((await seatOf(second)).seat, (await seatOf(first)).seat);
    assert.equal(valueOf(deviceSetCookie(second)!), valueOf(cookie), "and the cookie is renewed, not replaced");
  });

  test("two browsers on the same account get different seats", async () => {
    const a = await seatOf(await signIn());
    const b = await seatOf(await signIn());
    assert.equal(loginBodies[0]!.email, loginBodies[1]!.email);
    assert.ok(a.seat && b.seat);
    assert.notEqual(a.seat, b.seat);
  });

  test("a tampered cookie costs a new seat", async () => {
    const res = await signIn(`${DEVICE_COOKIE}=../../etc/passwd`);
    assert.equal(res.status, 200);
    assert.match(String((await seatOf(res)).seat), /^[A-Za-z0-9_-]{43}$/);
  });

  test("a planted second cookie is not adopted: a new key is minted instead", async () => {
    const real = newDeviceKey();
    const planted = newDeviceKey();
    const res = await signIn(`${DEVICE_COOKIE}=${real}; ${DEVICE_COOKIE}=${planted}`);
    assert.equal(res.status, 200);
    const minted = valueOf(deviceSetCookie(res)!);
    const { seat } = await seatOf(res);
    assert.notEqual(seat, seatIdFor(planted), "the planted key's seat is never the session's");
    assert.notEqual(seat, seatIdFor(real));
    assert.equal(seat, seatIdFor(minted));
  });

  test("a plain-named cookie planted on a deployment is ignored", async () => {
    const planted = newDeviceKey();
    const res = await signIn(`${DEVICE_COOKIE_INSECURE}=${planted}; faborch_device=${planted}`);
    assert.equal(res.status, 200);
    assert.notEqual((await seatOf(res)).seat, seatIdFor(planted));
  });

  test("a sign-in claiming plain http on a deployment still gets the __Host- cookie, Secure", async () => {
    const planted = newDeviceKey();
    const res = await signIn(`${DEVICE_COOKIE_INSECURE}=${planted}`, "https://pwa.test", {
      host: "pwa.test",
      "x-forwarded-proto": "http",
    });
    assert.equal(res.status, 200);
    const cookie = deviceSetCookie(res)!;
    assert.ok(cookie, "the __Host- cookie is the one set");
    assert.match(cookie, /Secure/i);
    assert.equal(deviceSetCookie(res, DEVICE_COOKIE_INSECURE), undefined);
    assert.notEqual((await seatOf(res)).seat, seatIdFor(planted), "the planted plain-named key is never adopted");
  });

  test("a refused sign-in sets no device cookie", async () => {
    foAccepts = false;
    const res = await signIn();
    assert.equal(res.status, 401);
    assert.equal(deviceSetCookie(res), undefined);
  });

  test("on loopback over plain http (local development) the plain name is used, not Secure", async () => {
    const res = await signIn("", "http://localhost:3002");
    assert.equal(res.status, 200);
    assert.equal(deviceSetCookie(res), undefined, "no __Host- cookie over http: a browser would refuse it");
    const cookie = deviceSetCookie(res, DEVICE_COOKIE_INSECURE)!;
    assert.ok(cookie);
    assert.doesNotMatch(cookie, /Secure/i);
    assert.match(cookie, /HttpOnly/i);
  });
});

describe("the seat is signed, not claimed", () => {
  const user = { id: "u1", email: "a@b.c", name: "A", roleName: "Operator" } as const;
  const IN_A_DAY = new Date(Date.now() + 864e5).toISOString();

  test("a session minted with a seat carries it; one minted without carries none", () => {
    const seat = seatIdFor(newDeviceKey());
    assert.equal(verifyToken(sessionFor({ ...user }, IN_A_DAY, "fo-token", undefined, seat).token)?.sid, seat);
    assert.equal(verifyToken(sessionFor({ ...user }, IN_A_DAY, "fo-token").token)?.sid, undefined);
  });

  test("a token whose seat was changed after signing does not verify", () => {
    const seat = seatIdFor(newDeviceKey());
    const other = seatIdFor(newDeviceKey());
    const { token } = sessionFor({ ...user }, IN_A_DAY, "fo-token", undefined, seat);
    const [body, signature] = token.split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...payload, sid: other })).toString("base64url");
    assert.equal(inspectToken(`${forged}.${signature}`).kind, "invalid");
  });
});

describe("the seat outlives the session", () => {
  test("sign-out clears the session cookie and leaves the device key alone", async () => {
    const first = await signIn();
    const cookies = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]!).join("; ");
    const out = await LOGOUT(
      new NextRequest("https://pwa.test/api/pwa/auth/logout", { method: "POST", headers: { cookie: cookies } }),
    );
    assert.equal(out.status, 200);
    const cleared = out.headers.getSetCookie?.() ?? [];
    assert.ok(
      cleared.some((c) => /^faborch_token=;/.test(c) && /Max-Age=0/i.test(c)),
      "the session cookie is cleared",
    );
    assert.ok(!cleared.some((c) => /faborch_seat=/.test(c)), "sign-out does not touch the device cookie");
  });
});
