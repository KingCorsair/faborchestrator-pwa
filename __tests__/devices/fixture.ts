/**
 * Shared fixture for the device-enrollment tests (`lib/devices/`).
 *
 * A fresh store file per test, a stub FabOrchestrator that knows a few users,
 * and request builders that carry cookies the way a browser would. Importing
 * this file sets the environment the routes need, so import it first.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL = "https://fo.test";
process.env.PUBLIC_ORIGIN = "https://pwa.test";
process.env.DEVICE_ADMIN_EMAILS = "admin@plant.example";

import { NextRequest, type NextResponse } from "next/server";
import { sessionFor } from "@/lib/auth";
import { resetRecentRevokes } from "@/lib/faborch/end-session";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { resetDeviceGateLogs } from "@/lib/devices/gate";
import { resetDeviceStores } from "@/lib/devices/store";
import { resetLoginFailures } from "@/lib/rate-limit";

export const ORIGIN = "https://pwa.test";
export const DEVICE_COOKIE = "__Host-fo_device";
export const ENROLL_COOKIE = "__Host-fo_enroll";

/** The users the stub FabOrchestrator knows: email → id and password. */
export const USERS: Record<string, { id: string; password: string; name: string }> = {
  "admin@plant.example": { id: "user-admin", password: "admin-pass", name: "Admin" },
  "alice@plant.example": { id: "user-alice", password: "alice-pass", name: "Alice" },
  "bob@plant.example": { id: "user-bob", password: "bob-pass", name: "Bob" },
};

export interface FoCall {
  method: string;
  path: string;
  body: string | null;
}

const realFetch = globalThis.fetch;
export const foCalls: FoCall[] = [];
/** When set, FabOrchestrator answers this user for any correct password (a mismatch test). */
let foAnswersAs: string | null = null;
export function setFoAnswersAs(email: string | null) {
  foAnswersAs = email;
}

export function stubFo(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : null;
    foCalls.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/auth/login") {
      const { email, password } = JSON.parse(body ?? "{}") as { email: string; password: string };
      const user = USERS[email];
      if (!user || user.password !== password) return Response.json({ error: "Invalid" }, { status: 401 });
      const as = foAnswersAs ?? email;
      return Response.json({
        token: `fo-token-${USERS[as]!.id}-${foCalls.length}`,
        expiresAt: new Date(Date.now() + 864e5).toISOString(),
        user: { id: USERS[as]!.id, email: as, name: USERS[as]!.name },
      });
    }
    if (url.pathname === "/api/auth/me") return Response.json({ user: { role: { name: "Operator" } } });
    if (url.pathname === "/api/auth/logout") return new Response(null, { status: 204 });
    return new Response("not stubbed", { status: 500 });
  }) as typeof fetch;
}

let dir: string | null = null;
let storePath = "";
export const currentStorePath = () => storePath;

export async function setUp(options: { gate?: "enforce" | "off" } = {}): Promise<void> {
  await resetDeviceStores();
  resetDeviceGateLogs();
  resetLoginFailures();
  resetRecentRevokes();
  dir = mkdtempSync(join(tmpdir(), "devices-"));
  storePath = join(dir, "devices.log");
  process.env.DEVICE_STORE_PATH = storePath;
  process.env.DEVICE_GATE = options.gate ?? "enforce";
  foCalls.length = 0;
  foAnswersAs = null;
  stubFo();
}

export async function tearDown(): Promise<void> {
  await resetDeviceStores();
  globalThis.fetch = realFetch;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
}

let address = 0;

/** A browser request to this app. Cookies by name; same-origin by default. */
export function request(
  path: string,
  options: {
    method?: string;
    cookies?: Record<string, string | null | undefined>;
    headers?: Record<string, string>;
    json?: unknown;
  } = {},
): NextRequest {
  address += 1;
  const cookie = Object.entries(options.cookies ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const headers: Record<string, string> = {
    "sec-fetch-site": "same-origin",
    "fly-client-ip": `10.9.${Math.floor(address / 250)}.${address % 250}`,
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ...(cookie ? { cookie } : {}),
    ...(options.json !== undefined ? { "content-type": "application/json" } : {}),
    ...(options.headers ?? {}),
  };
  return new NextRequest(`${ORIGIN}${path}`, {
    method: options.method ?? (options.json !== undefined ? "POST" : "GET"),
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
  });
}

/** A signed-in session for `email`: the bearer and the FabOrchestrator cookie, as sign-in leaves them. */
export function sessionOf(email: string): { bearer: string; foToken: string } {
  const user = USERS[email]!;
  const foToken = `fo-session-${user.id}`;
  const { token } = sessionFor(
    { id: user.id, email, name: user.name, roleName: "Operator" },
    new Date(Date.now() + 864e5).toISOString(),
    foToken,
  );
  return { bearer: `Bearer ${token}`, foToken };
}

/** The cookies a signed-in, enrolled browser sends. */
export function browser(device: string | null, session?: { foToken: string }): Record<string, string | null> {
  return { [DEVICE_COOKIE]: device, ...(session ? { [FO_TOKEN_COOKIE]: session.foToken } : {}) };
}

export function setCookie(res: NextResponse | Response, name: string): string | undefined {
  return (res as NextResponse).cookies?.get(name)?.value;
}

/** Where a redirect points, as a path, or null. */
export function redirectedTo(res: Response): string | null {
  const location = res.headers.get("location");
  return location ? new URL(location, ORIGIN).pathname : null;
}
