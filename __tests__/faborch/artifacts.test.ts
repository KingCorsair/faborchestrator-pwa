/**
 * WP9 — the dashboards FabOrchestrator writes into its answers.
 *
 * Until this package an artifact arrived as raw `<antArtifact>` markup rendered
 * as markdown: a wall of HTML in the middle of a sentence, which reads as a
 * broken product rather than a missing feature.
 *
 * Four things are asserted:
 *
 *   1. the parser is a faithful port — the two regexes are byte-identical to
 *      FabOrchestrator's, so a change upstream is a readable diff here
 *   2. streaming: a half-arrived document is a placeholder, never half a page
 *   3. the fallbacks — an unclosed tag, an unknown type, a failed frame — each
 *      show something, because the rule is never a blank rectangle
 *   4. the sandbox: `allow-scripts` without `allow-same-origin`, ever
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { presentationFor, segmentMessageText, typeLabel } from "../../lib/faborch/artifacts";
import { enforceLightHtml } from "../../lib/faborch/enforce-light";

const tag = (attrs: string, body: string) => `<antArtifact ${attrs}>${body}</antArtifact>`;
const HTML = "<html><body><h1>Yield</h1></body></html>";

/* ── 1. A faithful port ───────────────────────────────────────────────────── */

describe("the parser is a faithful copy of FabOrchestrator's", () => {
  const source = readFileSync(new URL("../../lib/faborch/artifacts.ts", import.meta.url), "utf8");

  test("the two regexes are byte-identical to the upstream file", () => {
    // The plan's instruction. These are copied from FO `lib/artifact-parser.ts`
    // lines 114-115 at upstream e5a5abd; keeping them character-for-character
    // is what makes a future upstream change diffable rather than silent.
    assert.ok(
      source.includes("/<antArtifact\\s+([^>]*?)>([\\s\\S]*?)<\\/(?:antArtifact|artifact)>/g"),
      "COMPLETE_TAG_RE has drifted from upstream",
    );
    assert.ok(
      source.includes("/<antArtifact\\s+([^>]*?)>([\\s\\S]*)$/"),
      "PARTIAL_TAG_RE has drifted from upstream",
    );
  });

  test("the shortened closing tag is accepted, because the model emits it", () => {
    // FO's own comment says models sometimes shorten </antArtifact> to
    // </artifact>. Without the alternation a finished dashboard would look
    // unterminated and show a "building" placeholder forever.
    const { segments, hasStreamingArtifact } = segmentMessageText(
      `Here it is.<antArtifact identifier="d" type="text/html" title="Yield">${HTML}</artifact>`,
    );
    assert.equal(hasStreamingArtifact, false);
    const art = segments.find((s) => s.type === "artifact");
    assert.ok(art && art.type === "artifact" && !art.isStreaming);
  });

  test("a message with no artifact is one text segment, untouched", () => {
    const text = "There are 237 lots currently in WIP.";
    assert.deepEqual(segmentMessageText(text), {
      segments: [{ type: "text", content: text }],
      hasStreamingArtifact: false,
    });
  });

  test("prose is preserved on both sides of an artifact", () => {
    const { segments } = segmentMessageText(
      `Before.${tag('identifier="d" type="text/html" title="Yield"', HTML)}After.`,
    );
    assert.deepEqual(
      segments.map((s) => (s.type === "text" ? s.content.trim() : "[artifact]")),
      ["Before.", "[artifact]", "After."],
    );
  });

  test("two artifacts in one answer are both found", () => {
    const { segments } = segmentMessageText(
      tag('identifier="a" type="text/html" title="One"', "<p>1</p>") +
        tag('identifier="b" type="text/html" title="Two"', "<p>2</p>"),
    );
    assert.equal(segments.filter((s) => s.type === "artifact").length, 2);
  });

  test("attributes are read, and missing ones take FabOrchestrator's defaults", () => {
    const { segments } = segmentMessageText(tag('identifier="x"', "<p>hi</p>"));
    const a = segments.find((s) => s.type === "artifact");
    assert.ok(a && a.type === "artifact");
    assert.equal(a.artifact.identifier, "x");
    assert.equal(a.artifact.type, "text/html", "FO defaults an absent type to text/html");
    assert.equal(a.artifact.title, "Artifact", "and an absent title to 'Artifact'");
  });

  test("the content is returned verbatim, not re-encoded", () => {
    // The frame renders this. Anything done to it here would change what the
    // operator sees relative to what FabOrchestrator produced.
    const body = "<div>x &amp; y</div>";
    const { segments } = segmentMessageText(tag('type="text/html" title="T"', body));
    const a = segments.find((s) => s.type === "artifact");
    assert.ok(a && a.type === "artifact");
    assert.equal(a.artifact.content, body);
  });
});

/* ── 2. Streaming ─────────────────────────────────────────────────────────── */

describe("a document still arriving is a placeholder, not half a page", () => {
  test("an unclosed tag is reported as streaming", () => {
    const { segments, hasStreamingArtifact } = segmentMessageText(
      'Building it.<antArtifact identifier="d" type="text/html" title="Yield by product"><html><bo',
    );
    assert.equal(hasStreamingArtifact, true);
    const a = segments.find((s) => s.type === "artifact");
    assert.ok(a && a.type === "artifact" && a.isStreaming);
    // The title arrives in the opening tag, so there is something to show.
    assert.equal(a.artifact.title, "Yield by product");
  });

  test("the prose before a streaming tag still renders", () => {
    const { segments } = segmentMessageText(
      'Here is the chart.<antArtifact type="text/html" title="T"><html>',
    );
    assert.equal(segments[0].type, "text");
    assert.match((segments[0] as { content: string }).content, /Here is the chart/);
  });

  test("a finished artifact before a streaming one is not mistaken for partial", () => {
    const { segments, hasStreamingArtifact } = segmentMessageText(
      tag('type="text/html" title="Done"', "<p>a</p>") +
        '<antArtifact type="text/html" title="Still going"><p>b',
    );
    const arts = segments.filter((s) => s.type === "artifact");
    assert.equal(arts.length, 2);
    assert.equal((arts[0] as { isStreaming: boolean }).isStreaming, false);
    assert.equal((arts[1] as { isStreaming: boolean }).isStreaming, true);
    assert.equal(hasStreamingArtifact, true);
  });

  test("segmenting stays sane as tokens arrive one at a time", () => {
    // The screen re-parses on every token, so every prefix of a real answer has
    // to produce something renderable.
    const full = `Intro.${tag('type="text/html" title="T"', "<p>body</p>")}Outro.`;
    for (let i = 1; i <= full.length; i += 7) {
      const { segments } = segmentMessageText(full.slice(0, i));
      assert.ok(segments.length >= 1, `nothing to render at prefix length ${i}`);
    }
  });
});

/* ── 3. Never a blank rectangle ───────────────────────────────────────────── */

describe("every artifact shows something", () => {
  test("html and svg are framed; everything else is shown as source", () => {
    assert.equal(presentationFor("text/html"), "frame");
    assert.equal(presentationFor("image/svg+xml"), "frame");
    assert.equal(presentationFor("text/markdown"), "source");
    assert.equal(presentationFor("text/mermaid"), "source");
    assert.equal(presentationFor("application/vnd.ant.react"), "source");
  });

  test("an unknown type falls back to source rather than being guessed at", () => {
    assert.equal(presentationFor("application/x-invented"), "source");
  });

  test("every known type gets a human label", () => {
    for (const t of ["text/html", "image/svg+xml", "text/markdown", "text/mermaid"]) {
      assert.ok(typeLabel(t).length > 0 && typeLabel(t) !== t, t);
    }
    // An unrecognised one falls back to the MIME string, which is at least
    // true, rather than to a wrong friendly name.
    assert.equal(typeLabel("application/x-invented"), "application/x-invented");
  });
});

/* ── Light-mode enforcement ───────────────────────────────────────────────── */

describe("artifacts render light, and sized for a phone", () => {
  test("the style is injected into a full document's head", () => {
    const out = enforceLightHtml("<html><head><title>t</title></head><body>x</body></html>");
    assert.match(out, /faborch-force-light/);
    assert.ok(out.indexOf("faborch-force-light") < out.indexOf("</head>"));
  });

  test("a fragment mid-stream still gets it", () => {
    assert.match(enforceLightHtml("<div>partial"), /faborch-force-light/);
  });

  test("a viewport is added, because these are authored for a desktop", () => {
    // Without one a 1024px dashboard renders at 980px and is then shrunk, which
    // makes every axis label illegible on a phone.
    assert.match(enforceLightHtml("<html><head></head><body>x</body></html>"), /name="viewport"/);
  });

  test("a document that sets its own viewport keeps it", () => {
    const own =
      '<html><head><meta name="viewport" content="width=device-width"></head><body>x</body></html>';
    assert.equal(
      enforceLightHtml(own).match(/name="viewport"/g)?.length,
      1,
      "must not add a second viewport",
    );
  });

  test("coloured accents are left alone", () => {
    // A red bar means out-of-spec. Overriding it would change what the chart
    // says; only dark grey surfaces are neutralised.
    const out = enforceLightHtml("<div>x</div>");
    assert.ok(!out.includes("bg-red"), "colour utilities must not be overridden");
    assert.ok(out.includes("bg-gray-9"), "but dark greys must be");
  });

  test("empty input is returned unchanged", () => {
    assert.equal(enforceLightHtml(""), "");
  });
});

/* ── 4. The sandbox ───────────────────────────────────────────────────────── */

describe("the frame cannot reach this app", () => {
  const sheet = readFileSync(
    new URL("../../components/fab/artifact-sheet.tsx", import.meta.url),
    "utf8",
  );

  test("allow-same-origin never appears beside allow-scripts", () => {
    // Together they cancel the sandbox: the frame takes the embedder's origin
    // and can read its cookies, storage and DOM. This app holds an httpOnly
    // FabOrchestrator token, and the document in the frame was written by a
    // model from data the operator asked about. FO's own pages use both; this
    // one must not.
    assert.ok(
      !/sandbox="[^"]*allow-same-origin/.test(sheet),
      "the sandbox must stay opaque-origin",
    );
    assert.match(sheet, /sandbox="allow-scripts"/);
  });

  test("the frame sends no referrer", () => {
    assert.match(sheet, /referrerPolicy="no-referrer"/);
  });

  test("a failed frame shows the source instead of nothing", () => {
    assert.match(sheet, /setFailed\(true\)/);
    assert.match(sheet, /could not be displayed/);
  });
});
