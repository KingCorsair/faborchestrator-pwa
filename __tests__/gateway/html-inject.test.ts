/**
 * The mobile shell injection (`lib/gateway/html-inject.ts`), WP6.
 *
 * One script tag is added to FabOrchestrator's own documents so a phone can
 * open FabOrchestrator's own sidebar. Two properties matter: it goes into
 * documents and nothing else, and a document always arrives whole — a
 * transform that drops bytes when the head is split across a chunk, or when
 * there is no head at all, would corrupt the page it is trying to help.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { injectShellScript, INJECTED_HEAD, shouldInjectShell } from "@/lib/gateway/html-inject";

/** A body delivered in the given pieces, as a stream. */
function streamOf(...pieces: string[]): ReadableStream<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (i >= pieces.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(pieces[i++]));
    },
  });
}

async function read(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

describe("what gets the shell", () => {
  test("an HTML document does", () => {
    assert.equal(shouldInjectShell("text/html; charset=utf-8", {}), true);
  });

  test("an RSC payload, a chunk, an image and a stream do not", () => {
    // Adding a tag to any of these would corrupt it.
    for (const ct of ["text/x-component", "application/javascript", "text/css", "image/png", "text/event-stream", "application/json"]) {
      assert.equal(shouldInjectShell(ct, {}), false, ct);
    }
  });

  test("a response with no content type does not", () => {
    assert.equal(shouldInjectShell(null, {}), false);
  });

  test("one variable turns it off without turning off embedding", () => {
    for (const off of ["0", "off", "false", "OFF"]) {
      assert.equal(shouldInjectShell("text/html", { FO_EMBED_SHELL: off }), false, off);
    }
    assert.equal(shouldInjectShell("text/html", { FO_EMBED_SHELL: "1" }), true);
  });
});

describe("where the tag lands", () => {
  test("immediately before </head>", async () => {
    const out = await read(injectShellScript(streamOf("<html><head><title>x</title></head><body>hi</body></html>")));
    assert.equal(out, `<html><head><title>x</title>${INJECTED_HEAD}</head><body>hi</body></html>`);
  });

  test("only once, even in a document with a later </head> in its text", async () => {
    const out = await read(injectShellScript(streamOf("<head></head><body>the string </head> appears again</body>")));
    assert.equal(out.split(INJECTED_HEAD).length - 1, 1);
  });

  test("a capitalised head tag is still matched", async () => {
    const out = await read(injectShellScript(streamOf("<HTML><HEAD></HEAD><BODY></BODY></HTML>")));
    assert.ok(out.includes(INJECTED_HEAD));
  });
});

describe("a document always arrives whole", () => {
  test("when </head> is split across two chunks", async () => {
    // The case that makes a naive per-chunk replace lose bytes.
    const out = await read(injectShellScript(streamOf("<html><head><title>x</title></he", "ad><body>hi</body></html>")));
    assert.equal(out, `<html><head><title>x</title>${INJECTED_HEAD}</head><body>hi</body></html>`);
  });

  test("when the tag is split one character at a time", async () => {
    const html = "<html><head></head><body>ok</body></html>";
    const out = await read(injectShellScript(streamOf(...html.split(""))));
    assert.equal(out, `<html><head>${INJECTED_HEAD}</head><body>ok</body></html>`);
  });

  test("when there is no head at all, the body is passed through unchanged", async () => {
    const html = "<html><body>no head here</body></html>";
    const out = await read(injectShellScript(streamOf(html)));
    assert.equal(out, html);
  });

  test("when the document is empty", async () => {
    assert.equal(await read(injectShellScript(streamOf(""))), "");
  });

  test("bytes after the insertion pass straight through", async () => {
    const tail = "x".repeat(5000);
    const out = await read(injectShellScript(streamOf("<head></head>", tail, tail)));
    assert.equal(out, `<head>${INJECTED_HEAD}</head>${tail}${tail}`);
  });

  test("multi-byte characters survive a split mid-character", async () => {
    // The decoder is streaming, so a UTF-8 sequence broken across chunks must
    // not be mangled into replacement characters.
    const encoder = new TextEncoder();
    const bytes = encoder.encode("<head></head><body>café ✓ 日本語</body>");
    const cut = 22;
    const out = await read(
      injectShellScript(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, cut));
            controller.enqueue(bytes.slice(cut));
            controller.close();
          },
        }),
      ),
    );
    assert.ok(out.includes("café ✓ 日本語"), out.slice(-40));
  });
});

/**
 * The PWA bootstrap in FabOrchestrator's documents (10 September).
 *
 * Chrome stopped offering to install the preview once the landing page became
 * FabOrchestrator's `/home`. This app declares its manifest in
 * `app/layout.tsx`, so Next emits the link into *this app's* documents only —
 * and after the whole-application correction, every page an operator stands on
 * is FabOrchestrator's. Chrome's own check reported `hasData: false` on
 * `/home`, `/chat` and `/reports`.
 *
 * The property: **an embedded FabOrchestrator document carries everything
 * Chrome needs to treat this origin as installable**, and carries nothing that
 * would override FabOrchestrator's own presentation.
 */
describe("the PWA bootstrap injected into FabOrchestrator's documents", () => {
  test("the manifest link is there — the piece whose absence broke install", async () => {
    const { PWA_BOOTSTRAP_TAGS } = await import("@/lib/gateway/html-inject");
    assert.match(PWA_BOOTSTRAP_TAGS, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  });

  test("and the three tags an iOS home-screen launch needs", async () => {
    const { PWA_BOOTSTRAP_TAGS } = await import("@/lib/gateway/html-inject");
    assert.match(PWA_BOOTSTRAP_TAGS, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
    // Without this, a home-screen launch opens inside Safari's chrome rather
    // than standalone — which is the installed experience on a phone.
    assert.match(PWA_BOOTSTRAP_TAGS, /name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(PWA_BOOTSTRAP_TAGS, /name="apple-mobile-web-app-title"/);
  });

  test("**no `theme-color`** — FabOrchestrator sets its own, twice", async () => {
    const { INJECTED_HEAD } = await import("@/lib/gateway/html-inject");
    // FabOrchestrator ships two media-scoped theme colours (#FAF9F5 light,
    // #262624 dark, verified on the deployment). A third, unscoped, would
    // override its theming with ours in one of the two schemes — and the point
    // of the whole exercise is that the product looks like FabOrchestrator.
    assert.ok(!/theme-color/i.test(INJECTED_HEAD), "must not inject a theme-color");
    // Same reasoning for the two other things it already has an opinion about.
    assert.ok(!/name="viewport"/i.test(INJECTED_HEAD), "must not inject a viewport");
    assert.ok(!/rel="icon"/i.test(INJECTED_HEAD), "must not inject a favicon");
  });

  test("the mobile shell still goes in, and the bootstrap goes in first", async () => {
    const { INJECTED_HEAD, SHELL_SCRIPT_TAG, PWA_BOOTSTRAP_TAGS } = await import("@/lib/gateway/html-inject");
    assert.ok(INJECTED_HEAD.includes(SHELL_SCRIPT_TAG));
    // A manifest link found early is one Chrome does not wait for the deferred
    // script to discover.
    assert.ok(INJECTED_HEAD.indexOf(PWA_BOOTSTRAP_TAGS) < INJECTED_HEAD.indexOf(SHELL_SCRIPT_TAG));
  });

  test("all of it lands inside the head of a streamed document", async () => {
    const { injectShellScript, INJECTED_HEAD } = await import("@/lib/gateway/html-inject");
    const doc = "<!DOCTYPE html><html><head><title>x</title></head><body>hi</body></html>";
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(doc));
        c.close();
      },
    });
    const out = await new Response(injectShellScript(source as never)).text();
    assert.ok(out.includes(INJECTED_HEAD), "the whole block should be present");
    assert.ok(out.indexOf(INJECTED_HEAD) < out.indexOf("</head>"), "and inside the head");
    assert.ok(out.includes("<body>hi</body>"), "the document must be otherwise untouched");
  });
});
