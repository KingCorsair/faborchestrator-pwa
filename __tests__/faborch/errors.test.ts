/**
 * WP3 — every FabOrchestrator error body reduces to a displayable string.
 *
 * The defect this suite exists to prevent: reading `body.error` directly.
 * FabOrchestrator answers with two different shapes, and against the canonical
 * one `body.error` is an **object** — which reaches the screen as
 * `[object Object]`, or throws if React is asked to render it as a child.
 *
 * Both shapes are read from the product, not invented:
 *   nested  lib/errors/api-error-handler.ts  → {error:{errorId,type,priority,message}}
 *   flat    app/api/modeling-agent/chat/route.ts → {error:"…not enabled for your role."}
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { foErrorMessage, foErrorTextOf } from "@/lib/faborch/client";

const FALLBACK = "FabOrchestrator could not answer that.";

describe("foErrorMessage", () => {
  test("the canonical nested envelope yields its message, not [object Object]", () => {
    const body = {
      error: {
        errorId: "7c1f4e2a-0b55-4c9d-9f31-2a6d8e5b0c11",
        type: "LAMBDA_MCP_CRASH",
        priority: "HIGH",
        message: "The data connection did not respond.",
      },
    };
    const out = foErrorMessage(body, FALLBACK);
    assert.equal(
      out,
      "The data connection did not respond. (errorId=7c1f4e2a-0b55-4c9d-9f31-2a6d8e5b0c11)",
    );
    assert.ok(!out.includes("[object Object]"));
  });

  test("a flat string error is passed through", () => {
    assert.equal(
      foErrorMessage({ error: "The Modeling Agent is not enabled for your role." }, FALLBACK),
      "The Modeling Agent is not enabled for your role.",
    );
  });

  test("the errorId survives even when the envelope carries no message", () => {
    const out = foErrorMessage({ error: { errorId: "abc-123", type: "SESSION_TIMEOUT" } }, FALLBACK);
    assert.ok(out.includes("abc-123"), out);
  });

  test("a top-level userMessage wins over a bare error", () => {
    assert.equal(
      foErrorMessage({ userMessage: "Say this", error: "not this" }, FALLBACK),
      "Say this",
    );
  });

  /**
   * The point of the suite. Every one of these is a real possibility from a
   * proxy, a gateway, or a future FO version, and not one may produce
   * "[object Object]", "undefined", "null" or a thrown error.
   */
  const HOSTILE: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a bare string body", "gateway timeout"],
    ["an empty object", {}],
    ["error: null", { error: null }],
    ["error: an array", { error: ["a", "b"] }],
    ["error: a number", { error: 500 }],
    ["error: an empty string", { error: "" }],
    ["error: whitespace only", { error: "   " }],
    ["error: an empty object", { error: {} }],
    ["error: nested nulls", { error: { errorId: null, message: null } }],
    ["error: message is an object", { error: { message: { deep: true } } }],
    ["an array body", [{ error: "x" }]],
  ];

  for (const [name, body] of HOSTILE) {
    test(`${name} never renders as an object or a placeholder`, () => {
      const out = foErrorMessage(body, FALLBACK);
      assert.equal(typeof out, "string");
      assert.ok(out.length > 0);
      assert.ok(!out.includes("[object Object]"), out);
      assert.ok(!/\b(undefined|null|NaN)\b/.test(out), out);
    });
  }
});

describe("foErrorTextOf", () => {
  test("reads the nested envelope off a Response", async () => {
    const res = new Response(JSON.stringify({ error: { errorId: "e-1", message: "Nope." } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(await foErrorTextOf(res, FALLBACK), "Nope. (errorId=e-1)");
  });

  test("a body that is not JSON falls back rather than throwing", async () => {
    const res = new Response("<html>502 Bad Gateway</html>", { status: 502 });
    assert.equal(await foErrorTextOf(res, FALLBACK), FALLBACK);
  });

  test("an empty body falls back rather than throwing", async () => {
    assert.equal(await foErrorTextOf(new Response(null, { status: 504 }), FALLBACK), FALLBACK);
  });
});
