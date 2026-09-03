/**
 * Artifacts render light, whatever the model emitted.
 *
 * Ported from FabOrchestrator `lib/enforce-light.ts` at upstream `e5a5abd`,
 * kept close to the original so a change there is a readable diff here. FO's
 * system prompt already forbids dark artifacts; this is the belt to that
 * braces, and it earns its place because a dashboard that comes out dark on a
 * phone in a bright fab is unreadable rather than merely ugly.
 *
 * The strategy, in FO's words and preserved here:
 *   - pin `color-scheme` to light, which fixes form controls and UA surfaces
 *   - force a white page with dark text as the base
 *   - neutralise dark *grey-family* surface utilities (Tailwind 700–950, black)
 *
 * The attribute-substring selectors also match `dark:bg-gray-900`, so OS-dark
 * variants are flattened too. Coloured accents — blue, green, amber — are left
 * alone deliberately: they carry meaning in a chart, and overriding them would
 * turn a red "out of spec" bar into something else.
 *
 * ── One addition of this app's own ──────────────────────────────────────────
 * A viewport meta. FO renders artifacts on a desktop canvas where none is
 * needed; here the frame is a phone, and without it a dashboard authored at
 * 1200px is rendered at 980px CSS and then shrunk, which makes every label
 * illegible. It is injected only when the document does not already set one.
 */

const FORCE_LIGHT_SNIPPET = `<meta name="color-scheme" content="light">
<style id="faborch-force-light">
  :root, html { color-scheme: light !important; }
  html, body { background-color: #ffffff !important; color: #1f2937 !important; }
  .dark { color-scheme: light !important; }
  [class*="bg-gray-7"],[class*="bg-gray-8"],[class*="bg-gray-9"],
  [class*="bg-slate-7"],[class*="bg-slate-8"],[class*="bg-slate-9"],
  [class*="bg-zinc-7"],[class*="bg-zinc-8"],[class*="bg-zinc-9"],
  [class*="bg-neutral-7"],[class*="bg-neutral-8"],[class*="bg-neutral-9"],
  [class*="bg-stone-7"],[class*="bg-stone-8"],[class*="bg-stone-9"],
  [class*="bg-black"] { background-color: #ffffff !important; }
</style>`;

/**
 * The viewport this app adds.
 *
 * `width=device-width` alone would reflow a desktop-width dashboard into a
 * 390px column, which breaks table and chart layouts that assume their width.
 * Letting it keep its own width and scroll — the sheet scrolls both axes — is
 * the honest presentation of a document authored for a bigger screen.
 */
const VIEWPORT_SNIPPET = `<meta name="viewport" content="width=1024, initial-scale=1, viewport-fit=cover">`;

/** Inject light-mode enforcement, and a viewport if the document lacks one. */
export function enforceLightHtml(html: string): string {
  if (!html) return html;

  const snippet = /<meta[^>]+name=["']viewport["']/i.test(html)
    ? FORCE_LIGHT_SNIPPET
    : `${VIEWPORT_SNIPPET}${FORCE_LIGHT_SNIPPET}`;

  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${snippet}</head>`);
  }
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body[^>]*>/i, (m) => `${m}${snippet}`);
  }
  // A fragment, or a partial document mid-stream. Prepending still applies.
  return `${snippet}${html}`;
}
