/**
 * Finding the dashboards FabOrchestrator writes into its answers.
 *
 * ── What arrives ────────────────────────────────────────────────────────────
 * When an operator asks for something visual, FO's model emits a self-contained
 * document inline in the `text-delta` stream, wrapped in
 *
 *     <antArtifact identifier="…" type="text/html" title="…">…</antArtifact>
 *
 * Until now this app rendered that markup as markdown, so a dashboard arrived
 * as a wall of raw HTML. That reads as a broken product rather than a missing
 * feature, which is why it is the largest visible gap left.
 *
 * ── A copy, deliberately, not an import ─────────────────────────────────────
 * Ported from FabOrchestrator `lib/artifact-parser.ts` (238 lines) at upstream
 * `e5a5abd`. The two apps are separate deployments with no shared package, so
 * this is a copy — and the plan's instruction is to keep the two regexes
 * **byte-identical** to the source and cite it, so that a change upstream shows
 * up here as a readable diff rather than a silent divergence.
 *
 * What is not ported: FO's `mapArtifactTypeToStrategy`, which picks between
 * Sandpack, Mermaid and code viewers for its desktop workspace. This app shows
 * a dashboard on a phone; it needs the MIME type, not a rendering strategy.
 */

/** One artifact, as its tag describes it. */
export interface FoArtifact {
  identifier: string;
  /** The MIME type from the tag. `text/html` when absent, matching FO. */
  type: string;
  title: string;
  content: string;
}

/** A message is a run of text with artifacts embedded in it. */
export type ArtifactSegment =
  | { type: "text"; content: string }
  | { type: "artifact"; artifact: FoArtifact; isStreaming: boolean };

export interface SegmentResult {
  segments: ArtifactSegment[];
  /** An artifact is still arriving: its closing tag has not been seen. */
  hasStreamingArtifact: boolean;
}

/*
 * Byte-identical to FabOrchestrator `lib/artifact-parser.ts:114-115`.
 *
 * The alternation in the closing tag is not defensive programming: the model
 * really does shorten `</antArtifact>` to `</artifact>`, and FO's own comment
 * says so. Dropping it would leave a complete artifact looking unterminated,
 * and this app would show a "building" placeholder that never resolves.
 */
const COMPLETE_TAG_RE = /<antArtifact\s+([^>]*?)>([\s\S]*?)<\/(?:antArtifact|artifact)>/g;
const PARTIAL_TAG_RE = /<antArtifact\s+([^>]*?)>([\s\S]*)$/;

/** `identifier="x" type="y"` → an object. FO `lib/artifact-parser.ts:34`. */
function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attrString)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

/** The defaults are FO's, so a tag missing attributes behaves the same here. */
function toArtifact(attrs: Record<string, string>, content: string, index: number): FoArtifact {
  return {
    identifier: attrs.identifier || `artifact-${index}`,
    type: attrs.type || "text/html",
    title: attrs.title || "Artifact",
    content,
  };
}

/**
 * Split an answer into alternating text and artifact segments.
 *
 * Ported from FO `segmentMessageText` (`lib/artifact-parser.ts:180-237`),
 * including the order of operations: complete tags first, then a single
 * unterminated tag in whatever remains. That order matters while streaming —
 * text arrives a token at a time, so on most frames the last tag is partial and
 * everything before it is already closed.
 *
 * Empty text between two artifacts is dropped rather than emitted as a blank
 * segment, which is FO's behaviour and keeps the screen from rendering gaps.
 */
export function segmentMessageText(text: string): SegmentResult {
  // Fast path: the overwhelming majority of answers carry no artifact, and
  // this runs on every token of every turn.
  if (!text.includes("<antArtifact")) {
    return { segments: [{ type: "text", content: text }], hasStreamingArtifact: false };
  }

  const segments: ArtifactSegment[] = [];
  let hasStreaming = false;
  let lastIndex = 0;
  let artifactCount = 0;

  // A fresh regex per call: `lastIndex` on a `g` regex is mutable state, and a
  // shared one would skip tags on the second call. FO constructs it the same
  // way and for the same reason.
  const completeRe = new RegExp(COMPLETE_TAG_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = completeRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index);
      if (before.trim()) segments.push({ type: "text", content: before });
    }
    segments.push({
      type: "artifact",
      artifact: toArtifact(parseAttributes(match[1]), match[2], artifactCount++),
      isStreaming: false,
    });
    lastIndex = match.index + match[0].length;
  }

  const remaining = text.slice(lastIndex);
  const partialMatch = remaining.match(PARTIAL_TAG_RE);

  if (partialMatch) {
    const beforePartial = remaining.slice(0, remaining.indexOf(partialMatch[0]));
    if (beforePartial.trim()) segments.push({ type: "text", content: beforePartial });

    segments.push({
      type: "artifact",
      artifact: toArtifact(parseAttributes(partialMatch[1]), partialMatch[2], artifactCount++),
      isStreaming: true,
    });
    hasStreaming = true;
  } else if (remaining.trim()) {
    segments.push({ type: "text", content: remaining });
  }

  return { segments, hasStreamingArtifact: hasStreaming };
}

/* ── How this app renders each type ───────────────────────────────────────── */

/**
 * What to do with an artifact of this MIME type.
 *
 * `frame` types are documents meant to be seen; everything else is shown as
 * source. The rule is deliberately conservative: an unrecognised type becomes a
 * readable code block rather than something this app guesses at, because the
 * plan's fallback rule is that a viewer never gets a blank rectangle.
 */
export type ArtifactPresentation = "frame" | "source";

export function presentationFor(type: string): ArtifactPresentation {
  const t = type.toLowerCase();
  return t === "text/html" || t === "image/svg+xml" ? "frame" : "source";
}

/** A short human label for the tile. FO's types are MIME strings. */
export function typeLabel(type: string): string {
  const t = type.toLowerCase();
  if (t === "text/html") return "Dashboard";
  if (t === "image/svg+xml") return "Diagram";
  if (t === "text/markdown") return "Document";
  if (t === "text/mermaid" || t === "application/vnd.ant.mermaid") return "Diagram source";
  if (t.includes("react")) return "Component source";
  if (t.startsWith("text/") || t.includes("javascript") || t.includes("json")) return "Source";
  return type;
}
