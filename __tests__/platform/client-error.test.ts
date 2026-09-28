/**
 * A crash in the browser, reported to the server.
 *
 * The endpoint is unauthenticated — the sign-in screen can crash too — so what
 * is pinned here is mostly what it refuses: a query string (where a question
 * lives), anything over a few KB, a flood from one address, and the browser's
 * own words reaching the alert channel.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { clientErrorReport, newReference } from "../../lib/client-error";
import { resetErrorAlerts } from "../../lib/report-error";
import { ClientErrorSchema } from "../../lib/validation";
import { POST } from "../../app/api/client-error/route";

const realFetch = globalThis.fetch;
const realConsoleError = console.error;

let logged: string[] = [];
let posts: { text?: string }[] = [];

let n = 0;
const send = (body: unknown, address = `10.7.0.${++n}`) =>
  POST(
    new NextRequest("https://pwa.test/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json", "fly-client-ip": address },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const report = (extra: Record<string, unknown> = {}) => ({
  reference: newReference(),
  message: "Cannot read properties of undefined (reading 'map')",
  path: "/fabinsight",
  ...extra,
});

beforeEach(() => {
  logged = [];
  posts = [];
  resetErrorAlerts();
  delete process.env.ERROR_ALERT_WEBHOOK_URL;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    posts.push(JSON.parse(String(init.body)));
    return new Response("ok");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
  delete process.env.ERROR_ALERT_WEBHOOK_URL;
});

describe("building the report in the browser", () => {
  test("takes the path, never the query string where a question lives", () => {
    const built = clientErrorReport(new Error("boom"), "/fabinsight?q=what is our scrap rate", "ref-abcdef1234");
    assert.equal(built.path, "/fabinsight");
    assert.ok(!JSON.stringify(built).includes("scrap"));
  });

  test("a path it cannot vouch for becomes /", () => {
    assert.equal(clientErrorReport(new Error("x"), "/a b<script>", "ref-abcdef1234").path, "/");
  });

  test("a long message is cut, and a missing one is described", () => {
    assert.equal(clientErrorReport(new Error("y".repeat(900)), "/", "ref-abcdef1234").message.length, 500);
    assert.match(clientErrorReport({}, "/", "ref-abcdef1234").message, /failed to render/);
  });

  test("its reference is one the server accepts", () => {
    for (let i = 0; i < 20; i++) {
      const built = clientErrorReport(new Error("x"), "/reports", newReference());
      assert.ok(ClientErrorSchema.safeParse(built).success, built.reference);
    }
  });
});

describe("the endpoint", () => {
  test("records a crash in the same log as every other failure", async () => {
    const sent = report();
    const res = await send(sent);
    assert.equal(res.status, 202);
    const line = JSON.parse(logged.at(-1)!) as {
      where: string;
      message: string;
      detail: { reference: string; path: string };
    };
    assert.equal(line.where, "client");
    assert.equal(line.detail.reference, sent.reference, "the reference on screen is the one in the log");
    assert.equal(line.detail.path, "/fabinsight");
  });

  test("a query string is refused outright", async () => {
    const res = await send(report({ path: "/fabinsight?q=secret question" }));
    assert.equal(res.status, 400);
    assert.equal(logged.length, 0);
  });

  test("an oversized report is refused before it is read", async () => {
    const res = await send(report({ message: "x".repeat(10_000) }));
    assert.equal(res.status, 413);
  });

  test("one address cannot fill the log", async () => {
    for (let i = 0; i < 15; i++) {
      assert.equal((await send(report(), "10.8.8.8")).status, 202);
    }
    assert.equal(logged.length, 10, "ten recorded; the rest accepted and dropped");
  });

  test("the alert says a screen crashed — never what the browser said", async () => {
    process.env.ERROR_ALERT_WEBHOOK_URL = "https://hooks.chat.test/secret";
    await send(report({ message: "@channel urgent: sign in again at evil.test" }));
    assert.equal(posts.length, 1);
    const text = posts[0]!.text ?? "";
    assert.match(text, /A screen crashed/);
    assert.ok(!text.includes("evil.test"), text);
  });
});
