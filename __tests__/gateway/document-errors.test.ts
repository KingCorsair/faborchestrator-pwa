/**
 * The gateway's own failures, in the shape the request can use (plan RP5 part
 * 3b), driven through the real route handler.
 *
 * One of FabOrchestrator's pages that cannot be delivered gets a small HTML
 * page with the same status and code — a phone must never show raw JSON in the
 * installed app's window — while an API call keeps the JSON envelope. Neither
 * carries FabOrchestrator's address or any configured value.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL = "https://fo.test";
process.env.FO_EMBED_MODE = "whole";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { GATEWAY_MARKER_HEADER } from "@/lib/gateway/registry";
import { GET } from "@/app/fo-gateway/[...path]/route";
import { seatStoreOwning, TEST_SEAT } from "./seat-fixture";

seatStoreOwning();

const FO_TOKEN = "fo-session-not-a-real-token";
const PWA_TOKEN = sessionFor(
  { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" },
  new Date(Date.now() + 864e5).toISOString(),
  FO_TOKEN,
  undefined,
  TEST_SEAT,
).token;

const realFetch = globalThis.fetch;
const realError = console.error;
beforeEach(() => {
  console.error = () => {};
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
  delete process.env.FO_UI_BASE_URL;
  delete process.env.FO_UI_SPLIT_ALLOWED;
});

const get = (path: string) =>
  GET(
    new NextRequest(new URL(`/fo-gateway${path}`, "https://pwa.test"), {
      headers: {
        [GATEWAY_MARKER_HEADER]: "1",
        authorization: `Bearer ${PWA_TOKEN}`,
        cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
      },
    }),
    { params: Promise.resolve({ path: path.slice(1).split("/") }) },
  );

describe("FabOrchestrator unreachable", () => {
  test("one of its pages: a small HTML page, same status and code, a way to try again", async () => {
    const res = await get("/chat");
    assert.equal(res.status, 503);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
    const html = await res.text();
    assert.match(html, /could not be reached/);
    assert.match(html, /faborch_unavailable/);
    assert.match(html, /Try again/);
    assert.ok(!html.includes("fo.test"), "never FabOrchestrator's address");
  });

  test("an API call: the JSON envelope", async () => {
    const res = await get("/api/conversations");
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { code: string }).code, "faborch_unavailable");
  });
});

describe("a preview UI build named without its switch (RP1 G18)", () => {
  test("its pages fail closed with the HTML page, and the configured host is never shown", async () => {
    process.env.FO_UI_BASE_URL = "http://secret-preview.internal:3000";
    const res = await get("/home");
    assert.equal(res.status, 503);
    const html = await res.text();
    assert.match(html, /not_configured/);
    assert.ok(!html.includes("secret-preview"), html);
  });
});
