/*
 * Service worker.
 *
 * Two jobs, and deliberately no third:
 *
 *  1. Exist, with a fetch handler, so browsers treat the app as installable.
 *  2. When a **navigation** fails because the network is gone, show the app's
 *     own /offline screen instead of the browser's error page. In a standalone
 *     window with no address bar, Chrome's dinosaur looks like the app crashed.
 *
 * ── What this deliberately does NOT cache ───────────────────────────────────
 * **Nothing under /api/.** Not orders, not issues, not analyses, not decisions.
 * A cached downtime figure is a wrong downtime figure, and this whole product
 * is an argument for not showing a supervisor a number you cannot stand behind.
 * Offline *data* is Tier 5 and needs a staleness story before it needs code.
 *
 * Only two things are precached: the offline page and the icons it draws with.
 * Both are static, both are versioned by CACHE, and neither can go stale in a
 * way that misleads anybody.
 *
 * ── Why not stale-while-revalidate for the app shell ────────────────────────
 * Next's build output is content-hashed, so a shell cached under one build and
 * a page served by the next disagree about chunk names — which fails as a blank
 * screen rather than as an error. Not worth it for a demo that has a network.
 *
 * ── One failed fetch is not "offline" (2026-08-18) ──────────────────────────
 * The defect this section exists for: launching the installed app from the iOS
 * Home Screen showed /offline on a phone with working network, while the same
 * URL opened from the QR code in Safari was fine.
 *
 * The cause is the cold launch. A standalone web app starts its own WebKit
 * process and issues the start_url navigation immediately; when the networking
 * stack is not attached yet, `fetch()` in here **rejects** rather than
 * returning an error status. The old handler read exactly one rejection as
 * "the network is gone" and served the offline page — which is a lie the user
 * cannot see through, because in a window with no address bar there is nothing
 * to reload and the page says the connection is at fault.
 *
 * Safari never showed it because a tab navigation happens in an already-running
 * process that already has the network. The bug needed a cold start to appear,
 * so it could only ever appear on the installed copy.
 *
 * Three defences, cheapest first:
 *   - **Navigation preload.** The browser starts the navigation request itself,
 *     in parallel with booting this worker, so the response does not depend on
 *     a fetch issued from a worker that is still starting up.
 *   - **Retry.** A rejection inside the first second of a launch is a race, not
 *     a verdict. GET navigations are idempotent and bodyless, so re-issuing one
 *     is free.
 *   - **Only then** the offline page, which is now what it claims to be.
 */

const CACHE = "faborch-offline-v3";
const OFFLINE_URL = "/offline";

const PRECACHE = [OFFLINE_URL, "/icon-192.png", "/apple-touch-icon.png"];

/**
 * Extra attempts a failed navigation gets before we accept that the network is
 * really gone. Two retries at 300ms and 600ms puts the last attempt about a
 * second after the first — comfortably past a cold-start race, and short enough
 * that a genuinely offline launch still reaches the offline page promptly
 * rather than sitting on a blank screen.
 */
const NAVIGATION_RETRIES = 2;
const RETRY_BACKOFF_MS = 300;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Re-issues a failed navigation before giving up on it.
 *
 * **GET only.** A POST navigation (a plain form submit) carries a body that is
 * consumed by the first attempt, so retrying one would either fail or, worse,
 * submit twice. Nothing in this app navigates by POST today — sign-in is a
 * `fetch` — but a retry loop that silently double-submits is exactly the kind
 * of thing that is added later by somebody who did not read this file.
 */
async function fetchNavigation(request) {
  const attempts = request.method === "GET" ? NAVIGATION_RETRIES + 1 : 1;

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(RETRY_BACKOFF_MS * attempt);
    try {
      return await fetch(request);
    } catch (error) {
      // Only a rejection lands here — a 404 or a 500 is an *answer*, and the
      // server's own error page must show through untouched.
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * The escape hatch, as a string.
 *
 * Deliberately self-contained: no stylesheet, no chunk, no cache entry, no
 * dependency on anything this worker might already have poisoned. It is shown
 * when a navigation fails while the browser believes it is online, and its one
 * job is to let somebody standing in front of a broken installed app throw away
 * every stored copy and start again — which is otherwise a Settings dive on
 * iOS, or deleting and re-adding the home-screen icon.
 */
const RECOVERY_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>FabOrchestrator — could not load</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         padding:24px calc(24px + env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) calc(24px + env(safe-area-inset-left));
         background:#f6f7fc; color:#161c34;
         font-family:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
  main { width:100%; max-width:420px; text-align:center; background:#fff; border:1px solid #e7e9f4;
         border-radius:22px; padding:38px 26px; box-shadow:0 24px 60px rgba(16,21,58,.16); }
  h1 { font-size:20px; margin:0 0 10px; letter-spacing:-.015em; }
  p { font-size:14px; line-height:1.6; color:#5d6680; margin:0 0 18px; }
  button { width:100%; min-height:48px; border:0; border-radius:13px; cursor:pointer;
           font-size:16px; font-weight:700; color:#fff;
           background:linear-gradient(135deg,#5b54e8,#4842d4); box-shadow:0 8px 20px rgba(91,84,232,.34); }
  small { display:block; margin-top:14px; font-size:12px; color:#667090; }
</style></head>
<body><main>
  <h1>Could not load the app</h1>
  <p>The network is reachable, so this is not a connection problem — this copy of
     the app has stored files it can no longer use. Resetting clears them and
     reloads from the server. Nothing you recorded is kept on this device, so
     nothing is lost.</p>
  <button id="reset" type="button">Reset and reload</button>
  <small>FabOrchestrator · demo environment</small>
</main>
<script>
document.getElementById("reset").addEventListener("click", async function () {
  this.disabled = true;
  this.textContent = "Resetting…";
  try {
    if (navigator.serviceWorker) {
      var regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(function (r) { return r.unregister(); }));
    }
    if (window.caches) {
      var keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    }
  } catch (e) {
    /* Reload anyway — a partial clear still beats staying here. */
  }
  location.replace("/");
});
</script>
</body></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually rather than addAll: one 404 must not throw away the whole
      // install and leave the app with no offline page at all.
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {
            /* Best effort. A missing icon is not worth failing an install. */
          }),
        ),
      );
      // Take over immediately rather than waiting for every tab to close. Safe
      // here because no old worker is protecting any cached state.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older versions of this worker, so bumping CACHE is all
      // it takes to retire a stale offline page.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));

      // Feature-detected because Safari only shipped navigation preload in 17,
      // and this app's whole reason for existing on a phone is iOS.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {
          /* Preload is an optimisation; fetchNavigation still answers. */
        });
      }

      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only navigations. Everything else — API calls, chunks, fonts, the wasm —
  // falls through to the network exactly as if no worker existed, which is what
  // `respondWith` not being called means.
  if (request.mode !== "navigate") return;

  // Never intercept the API, even if something navigates to it directly.
  if (new URL(request.url).pathname.startsWith("/api/")) return;

  event.respondWith(
    (async () => {
      // The browser may already have this in flight. Taking it costs nothing
      // and skips the worker's own fetch entirely, which is the whole point on
      // a cold launch. It rejects when the preload request itself failed — in
      // which case we still have our own attempts to make.
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
      } catch {
        /* Fall through and try it ourselves. */
      }

      try {
        return await fetchNavigation(request);
      } catch {
        // **Only claim "no connection" when the browser agrees.** `onLine` is a
        // weak signal — it reports a link, not reachability — but it is decisive
        // in one direction: if it is false there is genuinely no network, and
        // the offline page is the truth.
        if (self.navigator.onLine === false) {
          const cached = await caches.match(OFFLINE_URL);
          if (cached) return cached;
        }

        // Online, and the request still failed after a preload and two retries.
        // Something here is wrong, not the network — and the offline page would
        // be a lie, which is the failure this app was reported to have twice.
        //
        // **Generated, never cached.** A device in this state is one whose
        // stored copies cannot be trusted: that is how it got here. A response
        // built as a string at runtime cannot be stale, and its reset button is
        // the only thing that reliably breaks the loop where a cached page from
        // a dead build has no working JavaScript with which to fix itself.
        return new Response(RECOVERY_HTML, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    })(),
  );
});
