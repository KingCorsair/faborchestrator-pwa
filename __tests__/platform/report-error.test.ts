/**
 * Where unexpected failures go: one log line of a fixed shape, and — when a
 * webhook is configured — one alert per kind of failure every five minutes.
 *
 * What matters most here is what the alert may and may not carry, because it
 * leaves the server: no stack, no detail, nothing a chat channel would render as
 * a mention or a link, and never more than one per kind in the window.
 */

import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { reportError, resetErrorAlerts } from "../../lib/report-error";

const realFetch = globalThis.fetch;
const realConsoleError = console.error;

let logged: string[] = [];
let posts: { url: string; body: { text?: string } }[] = [];

const WEBHOOK = "https://hooks.chat.test/services/T000/B000/secret";

beforeEach(() => {
  logged = [];
  posts = [];
  resetErrorAlerts();
  delete process.env.ERROR_ALERT_WEBHOOK_URL;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    posts.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return new Response("ok");
  }) as typeof fetch;
});

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
  delete process.env.ERROR_ALERT_WEBHOOK_URL;
});

const lastLine = () => JSON.parse(logged.at(-1)!) as Record<string, unknown>;

describe("the log line", () => {
  test("is one JSON line, the same shape every time, with the id it returns", () => {
    const incident = reportError("faborch/chat", new Error("upstream broke"), { path: "/api/chat" });
    assert.equal(logged.length, 1);
    const line = lastLine();
    assert.equal(line.level, "error");
    assert.equal(line.where, "faborch/chat");
    assert.equal(line.incident, incident);
    assert.match(incident, /^inc-[0-9a-f]{8}$/);
    assert.equal(line.message, "upstream broke");
    assert.deepEqual(line.detail, { path: "/api/chat" });
    assert.equal(typeof line.stack, "string");
  });

  test("anything thrown is described, not just Errors", () => {
    reportError("x", "a bare string");
    assert.equal(lastLine().message, "a bare string");
    reportError("x", { status: 500 });
    assert.equal(lastLine().message, '{"status":500}');
  });

  test("the network's own reason is kept beside the sentence", () => {
    // What `fetch` throws for a refused connection: "fetch failed", with the
    // reason two causes down.
    const refused = new TypeError("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:4599"),
    });
    reportError("faborch/unreachable", new Error("Could not reach FabOrchestrator.", { cause: refused }));
    assert.equal(lastLine().message, "Could not reach FabOrchestrator. — connect ECONNREFUSED 127.0.0.1:4599");
  });

  test("an abort is not a reason, and is left out", () => {
    const aborted = new DOMException("This operation was aborted", "AbortError");
    reportError("faborch/timeout", new Error("FabOrchestrator did not answer within 15 seconds.", { cause: aborted }));
    assert.equal(lastLine().message, "FabOrchestrator did not answer within 15 seconds.");
  });

  test("a message is cut to 300 characters and kept on one line", () => {
    reportError("x", new Error(`first line\nsecond line ${"y".repeat(400)}`));
    const message = String(lastLine().message);
    assert.ok(message.length <= 300, `${message.length} characters`);
    assert.ok(!message.includes("\n"));
  });

  test("reporting never throws, whatever it is handed", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.doesNotThrow(() => reportError("x", circular));
    assert.doesNotThrow(() => reportError("x", undefined));
  });
});

describe("the alert", () => {
  test("is not sent when no webhook is configured", () => {
    reportError("x", new Error("boom"));
    assert.equal(posts.length, 0);
  });

  test("is one short line to the webhook, carrying the incident id", async () => {
    process.env.ERROR_ALERT_WEBHOOK_URL = WEBHOOK;
    const incident = reportError("faborch/unreachable", new Error("Could not reach FabOrchestrator"));
    await Promise.resolve();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.url, WEBHOOK);
    assert.match(posts[0]!.body.text ?? "", /faborch\/unreachable: Could not reach FabOrchestrator/);
    assert.ok((posts[0]!.body.text ?? "").includes(incident));
  });

  test("carries no stack and no detail — those stay in the log", async () => {
    process.env.ERROR_ALERT_WEBHOOK_URL = WEBHOOK;
    reportError("x", new Error("boom"), { path: "/secret-looking-path" });
    await Promise.resolve();
    const text = posts[0]!.body.text ?? "";
    assert.ok(!text.includes("/secret-looking-path"));
    assert.ok(!text.includes("at "), "no stack frames");
  });

  test("cannot mention a channel or smuggle a link", async () => {
    process.env.ERROR_ALERT_WEBHOOK_URL = WEBHOOK;
    reportError("x", new Error("<!channel> see <https://evil.test|this> & more"));
    await Promise.resolve();
    const text = posts[0]!.body.text ?? "";
    assert.ok(!text.includes("<"), text);
    assert.ok(!text.includes(">"), text);
    assert.match(text, /&lt;!channel&gt;/);
  });

  test("is never sent over plain http — the URL is its own credential", () => {
    process.env.ERROR_ALERT_WEBHOOK_URL = "http://hooks.chat.test/secret";
    reportError("x", new Error("boom"));
    assert.equal(posts.length, 0);
  });

  test("an outage is one alert, and the next says how many were held back", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    process.env.ERROR_ALERT_WEBHOOK_URL = WEBHOOK;

    for (let i = 0; i < 5; i++) reportError("faborch/timeout", new Error("slow"));
    assert.equal(posts.length, 1, "five failures in a minute, one alert");
    assert.equal(logged.length, 5, "but every one of them is in the log");

    mock.timers.tick(5 * 60_000);
    reportError("faborch/timeout", new Error("slow"));
    assert.equal(posts.length, 2);
    assert.match(posts[1]!.body.text ?? "", /4 more held back/);
  });

  test("different kinds of failure are throttled separately", () => {
    process.env.ERROR_ALERT_WEBHOOK_URL = WEBHOOK;
    reportError("faborch/timeout", new Error("slow"));
    reportError("client", new Error("crash"));
    assert.equal(posts.length, 2);
  });

  test("a caller can replace the words the alert carries, not the log's", () => {
    // How a browser's crash report is kept out of the chat channel: its text is
    // untrusted, so the alert says only that a screen crashed.
    process.env.ERROR_ALERT_WEBHOOK_URL = WEBHOOK;
    reportError("client", new Error("words from a browser"), {}, { alert: "A screen crashed" });
    assert.ok(!(posts[0]!.body.text ?? "").includes("words from a browser"));
    assert.equal(lastLine().message, "words from a browser");
  });

  test("a webhook that fails is not a second incident", async () => {
    process.env.ERROR_ALERT_WEBHOOK_URL = WEBHOOK;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    assert.doesNotThrow(() => reportError("x", new Error("boom")));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(logged.length, 1);
  });
});
