/**
 * Sign-in asks FabOrchestrator's `/api/auth/me` once, with the token it was
 * just given (plan RP2, login step 2; `foMe` ported from the `chetan` branch
 * and adapted).
 *
 * The chetan branch's version treated every refusal as "role unknown" and
 * signed the operator in. These pin the plan's outcomes instead: the real
 * role; a forced password change still signs in (FO's own pages hold it); an
 * inactive account or a token FO does not honour is refused with a code, and
 * the just-minted token is revoked before the answer, with no cookie set.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";

import { NextRequest } from "next/server";
import { verifyToken } from "@/lib/auth";
import { passwordMarkFor } from "@/lib/faborch/password-mark";
import { POST } from "@/app/api/pwa/auth/login/route";

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
let paths: string[] = [];

/** A FabOrchestrator whose login succeeds and whose `/me` answers `me()`. */
function stubFo(me: () => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === "/api/auth/login") {
      return Response.json({
        token: "fo-session-token",
        expiresAt: new Date(Date.now() + 864e5).toISOString(),
        user: { id: "fo-user-1", email: "operator@plant.example", name: "A. Operator" },
      });
    }
    if (path === "/api/auth/me") return me();
    if (path === "/api/auth/logout") return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

let n = 0;
const signIn = () => {
  n += 1;
  return POST(
    new NextRequest("https://pwa.test/api/pwa/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "fly-client-ip": `10.7.0.${n}` },
      body: JSON.stringify({ email: "operator@plant.example", password: "right-password" }),
    }),
  );
};

const roleOf = async (res: Response) => {
  const body = (await res.json()) as { token: string };
  return verifyToken(body.token)?.roleName;
};

beforeEach(() => {
  paths = [];
  process.env.FABORCH_BASE_URL = "https://fo.test";
  // FabOrchestrator's change page is served only when the app embeds it.
  process.env.FO_EMBED_MODE = "whole";
  console.error = () => {};
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

describe("the role comes from FabOrchestrator", () => {
  test("the operator's real role", async () => {
    stubFo(() => Response.json({ user: { id: "fo-user-1", role: { id: "r1", name: "Business User" } } }));
    const res = await signIn();
    assert.equal(res.status, 200);
    assert.equal(await roleOf(res), "Business User");
    assert.deepEqual(paths, ["/api/auth/login", "/api/auth/me"], "exactly one extra call");
  });

  test("no role on the account, or a body of the wrong shape, costs only the label", async () => {
    stubFo(() => Response.json({ user: { id: "fo-user-1", role: null } }));
    assert.equal(await roleOf(await signIn()), "Signed in");
    stubFo(() => Response.json({ nothing: "useful" }));
    assert.equal(await roleOf(await signIn()), "Signed in");
  });

  test("FabOrchestrator failing the lookup still signs the operator in", async () => {
    stubFo(() => new Response("boom", { status: 500 }));
    const res = await signIn();
    assert.equal(res.status, 200);
    assert.equal(await roleOf(res), "Signed in");
    assert.ok(res.headers.get("set-cookie")?.includes("faborch_token="));
  });

  test("the label never claims a role nobody has", async () => {
    stubFo(() => new Response("boom", { status: 500 }));
    assert.notEqual(await roleOf(await signIn()), "Supervisor");
  });
});

describe("answers that change the outcome", () => {
  test("a forced password change signs in, and is sent to FabOrchestrator's change page (G20)", async () => {
    stubFo(() =>
      Response.json(
        { error: "Password change required", code: "FORCE_PASSWORD_CHANGE", redirectTo: "/force-password-change" },
        { status: 403 },
      ),
    );
    const res = await signIn();
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { next: string | null }).next, "/force-password-change");
    assert.ok(res.headers.get("set-cookie")?.includes("faborch_token=fo-session-token"));
    assert.ok(!paths.includes("/api/auth/logout"), "the session is kept for the change");
  });

  test("where this app does not serve FabOrchestrator's change page, no next page is named", async () => {
    // `off` mode: the app's own screens, and no FabOrchestrator documents.
    process.env.FO_EMBED_MODE = "off";
    stubFo(() =>
      Response.json({ error: "Password change required", code: "FORCE_PASSWORD_CHANGE" }, { status: 403 }),
    );
    const res = await signIn();
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { next: string | null }).next, null, "never a link to a 404");
  });

  test("an ordinary sign-in names no next page", async () => {
    stubFo(() => Response.json({ user: { id: "fo-user-1", role: { id: "r1", name: "Business User" } } }));
    assert.equal(((await (await signIn()).json()) as { next: string | null }).next, null);
  });

  test("an account that is no longer active is refused with a code, and the token revoked", async () => {
    stubFo(() =>
      Response.json({ error: "Account is no longer active. Contact your administrator." }, { status: 403 }),
    );
    const res = await signIn();
    assert.equal(res.status, 403);
    const body = (await res.json()) as { code: string; error: string };
    assert.equal(body.code, "account_inactive");
    assert.ok(!/incorrect|password/i.test(body.error), "not presented as a wrong password");
    assert.equal(res.headers.get("set-cookie"), null, "no cookie");
    assert.ok(paths.includes("/api/auth/logout"), "the minted token is revoked");
  });

  test("a token FabOrchestrator does not honour is a 502, and the token revoked", async () => {
    stubFo(() => new Response(null, { status: 401 }));
    const res = await signIn();
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { code: string }).code, "upstream_error");
    assert.equal(res.headers.get("set-cookie"), null);
    assert.ok(paths.includes("/api/auth/logout"));
  });
});

describe("a password change FabOrchestrator did not finish (G20, §9 question 44)", () => {
  // FabOrchestrator's change-password updates the hash but, in the clone, does
  // not clear `forcePasswordChange`. The gateway marks the browser when a change
  // succeeds; a later sign-in FabOrchestrator still holds for a change is then
  // explained, not sent round the change page again.
  const forced = () =>
    Response.json(
      { error: "Password change required", code: "FORCE_PASSWORD_CHANGE", redirectTo: "/force-password-change" },
      { status: 403 },
    );
  const signInMarked = (userId = "fo-user-1") => {
    n += 1;
    return POST(
      new NextRequest("https://pwa.test/api/pwa/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "fly-client-ip": `10.7.1.${n}`,
          cookie: `faborch_pw_changed=${passwordMarkFor(userId)}`,
        },
        body: JSON.stringify({ email: "operator@plant.example", password: "right-password" }),
      }),
    );
  };

  test("still held after a change: a coded explanation, the new token revoked, no session", async () => {
    stubFo(forced);
    const res = await signInMarked();
    assert.equal(res.status, 403);
    const body = (await res.json()) as { code: string; error: string };
    assert.equal(body.code, "password_change_required");
    assert.match(body.error, /administrator/);
    assert.ok(!(res.headers.get("set-cookie") ?? "").includes("faborch_token="), "no session cookie");
    assert.ok(paths.includes("/api/auth/logout"), "the token just issued is revoked");
  });

  test("a mark left by somebody else on a shared handset changes nothing for this user", async () => {
    stubFo(forced);
    const res = await signInMarked("another-operator");
    assert.equal(res.status, 200, "sent to the change page as usual");
    assert.equal(((await res.json()) as { next: string | null }).next, "/force-password-change");
    assert.ok(!paths.includes("/api/auth/logout"));
  });

  test("once FabOrchestrator has cleared the flag, sign-in is ordinary and the mark is dropped", async () => {
    stubFo(() => Response.json({ user: { id: "fo-user-1", role: { id: "r1", name: "Business User" } } }));
    const res = await signInMarked();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie") ?? "", /faborch_pw_changed=;/);
  });
});
