/**
 * What this app adds to FabOrchestrator's own HTML (WP6, WP10).
 *
 * Two things, both in the `<head>`:
 *
 *  · the PWA bootstrap — manifest and Apple tags — without which a
 *    FabOrchestrator page cannot be installed (below);
 *  · one script tag, `/fo-shell.js`, carrying the single-sign-out watcher and
 *    the service-worker registration.
 *
 * ── No navigation (11 September) ────────────────────────────────────────────
 * From WP6 the script also injected navigation, because below 768px
 * FabOrchestrator hid its sidebar in a closed drawer whose only trigger was
 * inside it, and hid its header's links with nothing in their place.
 * FabOrchestrator now provides its own phone navigation — a bar with its
 * `SidebarTrigger` on the chat and modeling pages, a menu button in its header
 * on the cockpit and Reports — so the script injects none. See
 * `public/fo-shell.js`, and `docs/STATUS.md` for the history.
 *
 * ── Why a stream transform rather than buffering the document ───────────────
 * FabOrchestrator's chat document is 38 KB and its answers stream for minutes;
 * the gateway pipes bodies rather than collecting them, and that property is
 * worth keeping for the one path that also serves documents. This inserts the
 * tag as the bytes pass, holding back only enough to find `</head>` across a
 * chunk boundary, and gives up cleanly if the head never arrives.
 */

/** The shell script (WP6), added to every embedded FabOrchestrator document. */
export const SHELL_SCRIPT_TAG = '<script src="/fo-shell.js" defer></script>';

/**
 * The PWA bootstrap — **the thing that makes this app installable at all.**
 *
 * ── The regression this repairs (10 September) ──────────────────────────────
 * Reported: Chrome stopped offering to install the preview. Not the app's own
 * Install button — Chrome's own affordance, gone.
 *
 * The cause is a direct consequence of whole-application embedding. This app
 * declares its manifest in `app/layout.tsx` (`metadata.manifest`), so Next
 * emits `<link rel="manifest">` into **this app's own documents**. Before the
 * correction the landing page was one of those. After it, `/` leads to
 * FabOrchestrator's `/home`, and `/chat` and `/reports` are FabOrchestrator's
 * too — so every page an operator actually stands on is a FabOrchestrator
 * document, and **not one of them carried a manifest link**. Measured against
 * the deployed preview with Chrome's own check (`Page.getAppManifest`):
 * `hasData: false` on `/home`, `/chat` and `/reports`; only `/login` had one.
 * No manifest on the current document means no install affordance, whatever
 * else is true.
 *
 * **The service worker was never the problem.** It registers from `/login`
 * during sign-in with scope `/`, and it was measured *active and controlling*
 * `/home`, `/chat` and `/reports`. Installability needs both halves; only the
 * manifest half had gone missing.
 *
 * ── Why this belongs here and not in FabOrchestrator ───────────────────────
 * Installability, the manifest, the icons and the service worker are this
 * app's job — that is the whole division of labour the corrected architecture
 * rests on: FabOrchestrator supplies the product, this app supplies the
 * installable mobile delivery of it. Asking Danish's team to add our manifest
 * link to their `<head>` would put our packaging concern in their repository.
 * The document-injection layer already exists for exactly this kind of thing.
 *
 * ── What is deliberately NOT injected ──────────────────────────────────────
 * **`theme-color`.** FabOrchestrator already sets two, media-scoped to light
 * and dark (`#FAF9F5` / `#262624`, verified on the deployment). Adding a third,
 * unscoped, would override its theming with ours in one of the two schemes —
 * and the point of the whole exercise is that the product looks like
 * FabOrchestrator. Its `viewport` and `favicon` are likewise left alone.
 *
 * What is added is only what FabOrchestrator has no opinion about: the
 * manifest, and the three Apple tags that decide how an iOS home-screen launch
 * behaves. `apple-mobile-web-app-capable` is what makes that launch open
 * without Safari's chrome, which is the installed experience on a phone.
 */
export const PWA_BOOTSTRAP_TAGS =
  '<link rel="manifest" href="/manifest.webmanifest">' +
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">' +
  '<meta name="apple-mobile-web-app-capable" content="yes">' +
  '<meta name="apple-mobile-web-app-title" content="FabOrch">';

/**
 * Everything this app adds to a FabOrchestrator document, in one string.
 *
 * The bootstrap comes first: a manifest link found early is a manifest link
 * Chrome does not have to wait for the deferred script to discover.
 */
export const INJECTED_HEAD = PWA_BOOTSTRAP_TAGS + SHELL_SCRIPT_TAG;

const HEAD_CLOSE = "</head>";

/**
 * How far into the document to keep looking for `</head>`.
 *
 * FabOrchestrator's head is under 4 KB. Past this the document is not shaped
 * the way this expects, and passing the rest through untouched is better than
 * holding a stream open on the chance that it is.
 */
const GIVE_UP_AFTER_BYTES = 256 * 1024;

/** Is the shell script wanted for this response? */
export function shouldInjectShell(
  contentType: string | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  // Off with one variable, without giving up embedding itself. Turning the
  // surfaces off removes the injection too, because nothing is proxied.
  const flag = (env.FO_EMBED_SHELL ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "off" || flag === "false") return false;
  // Documents only. An RSC payload is not HTML and a chunk is not a document;
  // adding a tag to either would corrupt it.
  return !!contentType && contentType.toLowerCase().startsWith("text/html");
}

/**
 * Insert the tag before `</head>`, as the body streams.
 *
 * The first chunks are accumulated until the head's end is found, so a
 * `</head>` split across a chunk boundary is still matched. Once inserted, or
 * once the search is abandoned, bytes pass straight through.
 */
export function injectShellScript(
  // `BodyInit`'s stream type, so the result can be handed straight to a
  // `Response` without a cast. `TextEncoder` produces exactly this.
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  tag: string = INJECTED_HEAD,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let done = false;

  return body.pipeThrough(
    new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        if (done) {
          controller.enqueue(chunk);
          return;
        }

        pending += decoder.decode(chunk, { stream: true });
        const at = pending.toLowerCase().indexOf(HEAD_CLOSE);

        if (at !== -1) {
          const withTag = pending.slice(0, at) + tag + pending.slice(at);
          controller.enqueue(encoder.encode(withTag));
          pending = "";
          done = true;
          return;
        }

        if (pending.length > GIVE_UP_AFTER_BYTES) {
          controller.enqueue(encoder.encode(pending));
          pending = "";
          done = true;
        }
        // Otherwise hold: `</head>` may straddle this chunk and the next.
      },
      flush(controller) {
        // A document that ended without a `</head>` still has to arrive whole.
        if (pending) controller.enqueue(encoder.encode(pending));
      },
    }),
  );
}
