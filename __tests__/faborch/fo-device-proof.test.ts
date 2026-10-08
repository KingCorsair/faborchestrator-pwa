/**
 * Sign-in passes a phone's device proof on to FabOrchestrator, which owns
 * approved devices (its Admin → Devices), and shows FabOrchestrator's device
 * refusal for what it is rather than as a wrong password.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL = "https://fo.test";

import { NextRequest } from "next/server";
import { POST } from "@/app/api/pwa/auth/login/route";

const realFetch = globalThis.fetch;
const realError = console.error;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
});

const PROOF = {
  deviceId: "0b6c1d6e-6a0e-4a58-9d5e-2f1b8f4f9a11",
  challenge: "1791400000000.abcDEF123_-.mac_value-Here",
  signature: "c2lnbmF0dXJlLWJ5dGVz_-",
};

/** A FabOrchestrator whose login answers `login`; records each login body. */
function fo(login: () => Response) {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth/login") {
      bodies.push(JSON.parse(String(init.body)));
      return login();
    }
    if (path === "/api/auth/me") return Response.json({ user: { id: "fo-user-1", role: { name: "Business User" } } });
    if (path === "/api/auth/logout") return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return bodies;
}

const signedIn = () =>
  Response.json({
    token: "fo-session-token",
    expiresAt: new Date(Date.now() + 864e5).toISOString(),
    user: { id: "fo-user-1", email: "operator@plant.example", name: "Op" },
  });

let n = 0;
const login = (body: Record<string, unknown>) => {
  n += 1;
  return POST(
    new NextRequest("https://pwa.test/api/pwa/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "fly-client-ip": `10.7.0.${n}` },
      body: JSON.stringify({ email: "operator@plant.example", password: "correct-horse", ...body }),
    }),
  );
};

describe("the device proof goes to FabOrchestrator as it came", () => {
  test("a phone's proof is in FabOrchestrator's login body, unchanged", async () => {
    const bodies = fo(signedIn);
    const res = await login({ device: PROOF });
    assert.equal(res.status, 200);
    assert.deepEqual(bodies[0]?.device, PROOF);
  });

  test("a phone without a device key sends no proof", async () => {
    const bodies = fo(signedIn);
    assert.equal((await login({})).status, 200);
    assert.equal("device" in (bodies[0] ?? {}), false);
  });

  test("a malformed proof is refused here, before FabOrchestrator is asked", async () => {
    const bodies = fo(signedIn);
    const res = await login({ device: { ...PROOF, signature: "not base64url!" } });
    assert.equal(res.status, 400);
    assert.equal(bodies.length, 0);
  });
});

describe("FabOrchestrator refusing the device", () => {
  test("not approved: 403 with FabOrchestrator's own words, not 'incorrect password'", async () => {
    console.error = () => {};
    fo(() => Response.json({ code: "DEVICE_NOT_APPROVED", error: "This device is not approved for FabOrchestrator." }, { status: 403 }));
    const res = await login({});
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { code: "device_not_approved", error: "This device is not approved for FabOrchestrator." });
  });

  test("revoked: its own code", async () => {
    fo(() => Response.json({ code: "DEVICE_REVOKED", error: "This device has been removed." }, { status: 403 }));
    const res = await login({ device: PROOF });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, "device_revoked");
  });

  test("any other 403 (a suspended account) still reads as a wrong password", async () => {
    fo(() => Response.json({ error: "This account has been suspended." }, { status: 403 }));
    const res = await login({});
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, "invalid_credentials");
  });
});
