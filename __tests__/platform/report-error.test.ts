/**
 * `lib/report-error.ts`: one JSON line of a fixed shape, an incident id, and
 * nothing in the production line that could carry a credential or a person's
 * words (plan RP10-A part 2).
 *
 * Adapted from the `chetan` branch's suite (`e843b9c`); the alert cases went
 * with the webhook, which was not ported.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { maskPath, reportError } from "../../lib/report-error";

const realConsoleError = console.error;
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  delete process.env.LOG_STACKS;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.error = realConsoleError;
  delete process.env.LOG_STACKS;
});

const lastLine = () => JSON.parse(logged.at(-1)!) as Record<string, unknown>;

describe("the log line", () => {
  test("is one JSON line, the same shape every time, with the id it returns", () => {
    const incident = reportError("faborch/timeout", new Error("slow"), { timeoutMs: 15000 });
    assert.equal(logged.length, 1);
    const line = lastLine();
    assert.equal(line.level, "error");
    assert.equal(line.where, "faborch/timeout");
    assert.equal(line.incident, incident);
    assert.match(incident, /^inc-[0-9a-f]{8}$/);
    assert.equal(line.errorName, "Error");
    assert.deepEqual(line.detail, { timeoutMs: 15000 });
  });

  test("carries the network's code from down the cause chain", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:3000"), { code: "ECONNREFUSED" });
    const fetchFailed = new TypeError("fetch failed", { cause: refused });
    reportError("faborch/unreachable", new Error("Could not reach FabOrchestrator.", { cause: fetchFailed }));
    const line = lastLine();
    assert.equal(line.errorName, "TypeError");
    assert.equal(line.errorCode, "ECONNREFUSED");
  });

  test("in production, no message and no stack — they are where secrets leak", () => {
    const planted = "tok_0123456789abcdefghijklmnopqrstuv user@example.com https://user:pw@fo.internal";
    reportError("x", new Error(planted, { cause: new Error(planted) }));
    const raw = logged.at(-1)!;
    assert.ok(!raw.includes("tok_0123456789"), raw);
    assert.ok(!raw.includes("user@example.com"), raw);
    assert.ok(!raw.includes("fo.internal"), raw);
    assert.equal(lastLine().message, undefined);
    assert.equal(lastLine().stack, undefined);
  });

  test("LOG_STACKS=1 adds the words and the stack, on one line", () => {
    process.env.LOG_STACKS = "1";
    reportError("x", new Error(`first line\nsecond ${"y".repeat(400)}`));
    const message = String(lastLine().message);
    assert.ok(message.length <= 300, `${message.length} characters`);
    assert.ok(!message.includes("\n"));
    assert.equal(typeof lastLine().stack, "string");
  });

  test("a path in detail is logged as a pattern, without its query", () => {
    reportError("x", new Error("e"), {
      path: "/api/conversations/3f2b8c1e-9a4d-4c7e-8b1a-2d3e4f5a6b7c?q=what+is+yield",
    });
    assert.equal((lastLine().detail as Record<string, unknown>).path, "/api/conversations/:id");
  });

  test("anything thrown is described, not just Errors, and reporting never throws", () => {
    reportError("x", "a bare string");
    assert.equal(lastLine().errorName, "Error");
    reportError("x", { status: 500 });
    assert.equal(lastLine().errorName, "NonError");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    process.env.LOG_STACKS = "1";
    assert.doesNotThrow(() => reportError("x", circular));
    assert.doesNotThrow(() => reportError("x", undefined));
  });
});

describe("maskPath", () => {
  test("keeps fixed segments and masks identifiers", () => {
    assert.equal(maskPath("/api/auth/login"), "/api/auth/login");
    assert.equal(maskPath("/api/files/file_011CUabcdefghijklmnop/download"), "/api/files/:id/download");
    assert.equal(maskPath("/api/chat#frag"), "/api/chat");
  });
});
