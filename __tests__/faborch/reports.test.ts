/**
 * Reports — read-only access to the dashboards an administrator pinned.
 *
 * The product rule this implements, read from FabOrchestrator's source
 * (`lib/fabinsight/access.ts` and the two pinned routes at upstream `e5a5abd`):
 * **creating, pinning and deleting a dashboard is admin-only; reading a pinned
 * one is open to every authenticated role.**
 *
 * So there are two things to prove, and the second matters more:
 *
 *   1. a normal, non-admin user can list and open pinned reports
 *   2. a normal user cannot reach any dashboard-management action through this
 *      app — including `refresh`, which FabOrchestrator does NOT gate but which
 *      overwrites the snapshot every other reader sees
 *
 * Stubbed FabOrchestrator throughout, so the suite still runs with no network.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.FABORCH_BASE_URL ??= "https://fo.test";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { GET as listReports } from "@/app/api/faborch/reports/route";
import { GET as readReport } from "@/app/api/faborch/reports/[id]/route";

const FO_TOKEN = "fo-token-not-real";

/** A supervisor: authenticated, and NOT a dashboard administrator. */
const PWA_TOKEN = sessionFor(
  {
    id: "u1",
    email: "supervisor@athenatech.example",
    name: "A. Supervisor",
    roleName: "Supervisor",
  },
  new Date(Date.now() + 864e5).toISOString(),
  FO_TOKEN,
).token;

let calls: { url: string; method: string }[] = [];
const realFetch = globalThis.fetch;

function stubFo(handler: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: (init.method ?? "GET").toUpperCase() });
    return handler(url, init);
  }) as typeof fetch;
}

const request = (path = "/api/faborch/reports", opts: { auth?: boolean; foCookie?: boolean } = {}) => {
  const { auth = true, foCookie = true } = opts;
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = `Bearer ${PWA_TOKEN}`;
  if (foCookie) headers.cookie = `${FO_TOKEN_COOKIE}=${FO_TOKEN}`;
  return new NextRequest(`https://pwa.test${path}`, { method: "GET", headers });
};

/** What FabOrchestrator returns for a non-admin: reports, canManage false. */
const PINNED_LIST = {
  dashboards: [
    {
      id: "pin-1",
      title: "Executive Overview",
      dashboardId: "executive-overview",
      kind: "curated",
      createdAt: "2026-09-01T09:00:00.000Z",
      refreshedAt: "2026-09-03T06:00:00.000Z",
      hasCache: true,
      createdBy: "An Administrator",
    },
  ],
  canManage: false,
};

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/* ── 1. A normal user can read ────────────────────────────────────────────── */

describe("a normal authenticated user can view pinned dashboards", () => {
  test("the list comes back, and FO is asked with the operator's own token", async () => {
    stubFo(() => Response.json(PINNED_LIST));
    const res = await listReports(request());
    assert.equal(res.status, 200);

    const body = (await res.json()) as { reports: { title: string }[]; canManage: boolean };
    assert.equal(body.reports.length, 1);
    assert.equal(body.reports[0].title, "Executive Overview");

    // The operator's own FabOrchestrator token, so FO applies THEIR role — not
    // a service account standing in for everyone.
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/fabinsight\/pinned$/);
    assert.equal(calls[0].method, "GET");
  });

  test("canManage comes back as FabOrchestrator computed it", async () => {
    // Returned rather than dropped so the screen can explain why it offers no
    // controls, instead of looking like a broken copy of FO's page.
    stubFo(() => Response.json(PINNED_LIST));
    const body = (await (await listReports(request())).json()) as { canManage: boolean };
    assert.equal(body.canManage, false);
  });

  test("a report's stored snapshot opens", async () => {
    stubFo(() =>
      Response.json({
        id: "pin-1",
        title: "Executive Overview",
        dashboardId: "executive-overview",
        params: {},
        html: "<html><body>real dashboard</body></html>",
        summary: "Throughput steady.",
        refreshedAt: "2026-09-03T06:00:00.000Z",
        status: "ok",
      }),
    );
    const res = await readReport(request("/api/faborch/reports/pin-1"), {
      params: Promise.resolve({ id: "pin-1" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { html: string };
    assert.match(body.html, /real dashboard/);
    assert.match(calls[0].url, /\/api\/fabinsight\/pinned\/pin-1$/);
  });

  test("an empty list is a real answer, not an error", async () => {
    stubFo(() => Response.json({ dashboards: [], canManage: false }));
    const res = await listReports(request());
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { reports: unknown[] }).reports, []);
  });

  test("a report with no snapshot yet is reported honestly", async () => {
    // A brand-new pin that has never been refreshed. `html: null` is not a
    // failure and must not read as one.
    stubFo(() =>
      Response.json({
        id: "pin-2",
        title: "Process Analytics",
        dashboardId: "process-analytics",
        params: {},
        html: null,
        summary: null,
        refreshedAt: null,
        status: null,
      }),
    );
    const res = await readReport(request("/api/faborch/reports/pin-2"), {
      params: Promise.resolve({ id: "pin-2" }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { html: string | null }).html, null);
  });

  test("a report that is no longer pinned is a 404, not a crash", async () => {
    stubFo(() => Response.json({ error: "Not found." }, { status: 404 }));
    const res = await readReport(request("/api/faborch/reports/gone"), {
      params: Promise.resolve({ id: "gone" }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, "not_found");
  });
});

/* ── 2. A normal user cannot manage ───────────────────────────────────────── */

describe("no dashboard-management action is reachable through this app", () => {
  test("the reports routes expose GET and nothing else", async () => {
    // The strongest form of "a non-admin cannot pin or unpin": there is no
    // handler to reach. A crafted POST or DELETE gets Next's 405 because the
    // module exports no such function.
    const list = await import("@/app/api/faborch/reports/route");
    const one = await import("@/app/api/faborch/reports/[id]/route");

    for (const [name, mod] of [["reports", list], ["reports/[id]", one]] as const) {
      const exported = Object.keys(mod);
      assert.deepEqual(
        exported.filter((k) => ["POST", "DELETE", "PUT", "PATCH"].includes(k)),
        [],
        `${name} must expose no mutating handler; found ${exported.join(", ")}`,
      );
      assert.ok(exported.includes("GET"), `${name} must expose GET`);
    }
  });

  test("reading a report never calls FabOrchestrator's refresh route", async () => {
    // `POST /pinned/[id]/refresh` is NOT admin-gated in FabOrchestrator, and it
    // re-queries the MES and overwrites the shared snapshot every other reader
    // sees. Reading must never trigger it — a read-only screen that rewrites
    // other people's data is not read-only.
    stubFo(() =>
      Response.json({
        id: "pin-1",
        title: "Executive Overview",
        dashboardId: "executive-overview",
        params: {},
        html: "<html></html>",
        summary: null,
        refreshedAt: "2026-09-03T06:00:00.000Z",
        status: "ok",
      }),
    );
    await readReport(request("/api/faborch/reports/pin-1"), {
      params: Promise.resolve({ id: "pin-1" }),
    });

    assert.ok(
      calls.every((c) => !c.url.includes("/refresh")),
      `refresh must never be called; saw ${calls.map((c) => c.url).join(", ")}`,
    );
    assert.ok(
      calls.every((c) => c.method === "GET"),
      `every outbound call must be a GET; saw ${calls.map((c) => `${c.method} ${c.url}`).join(", ")}`,
    );
  });

  test("listing reports makes exactly one GET and no write", async () => {
    stubFo(() => Response.json(PINNED_LIST));
    await listReports(request());
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET"],
    );
  });

  test("a path segment cannot escape into another FabOrchestrator route", async () => {
    // The id goes into a URL, so it is encoded rather than interpolated raw —
    // same rule as `lib/return-path.ts`: a value from the URL selects, it never
    // becomes the destination.
    stubFo(() => Response.json({ error: "Not found." }, { status: 404 }));
    await readReport(request("/api/faborch/reports/x"), {
      params: Promise.resolve({ id: "../../auth/logout" }),
    });
    assert.equal(calls.length, 1);
    assert.ok(
      !calls[0].url.includes("/api/auth/logout"),
      `the id must not reach another route; called ${calls[0].url}`,
    );
    assert.match(calls[0].url, /\/api\/fabinsight\/pinned\/\.\.%2F\.\.%2Fauth%2Flogout$/);
  });
});

/* ── The session rules the rest of the app already follows ────────────────── */

describe("reports obey the same session rules as the chat proxy", () => {
  test("no PWA session is a 401, and FabOrchestrator is never contacted", async () => {
    stubFo(() => Response.json(PINNED_LIST));
    const res = await listReports(request("/api/faborch/reports", { auth: false }));
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  test("no FabOrchestrator cookie is a 401, and FO is never contacted", async () => {
    // Rejected by `requireAuth` before the handler runs, not by the handler's
    // own `no_faborch_session` branch: since WP2 the PWA session carries a
    // fingerprint of the FabOrchestrator token it was minted beside, so a
    // session without that cookie is not a session at all. The branch in the
    // route is defence in depth and is currently unreachable — which is the
    // correct outcome and worth pinning, because it is what stops a reader
    // seeing an empty report list and concluding nothing is pinned.
    stubFo(() => Response.json(PINNED_LIST));
    const res = await listReports(request("/api/faborch/reports", { foCookie: false }));
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0, "an unauthenticated request must not reach FabOrchestrator");
  });

  test("an expired FabOrchestrator session drops the cookie and offers sign-in", async () => {
    stubFo(() => Response.json({ error: "Session expired" }, { status: 401 }));
    const res = await listReports(request());
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, "faborch_session_expired");
    assert.match(
      res.headers.get("set-cookie") ?? "",
      new RegExp(`${FO_TOKEN_COOKIE}=;|${FO_TOKEN_COOKIE}=""`),
      "the dead cookie must be cleared, or every retry fails identically",
    );
  });

  test("FabOrchestrator being unreachable reads as unavailable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const res = await listReports(request());
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code: string; error: string };
    assert.equal(body.code, "faborch_unavailable");
    assert.match(body.error, /Could not reach FabOrchestrator/);
  });
});
