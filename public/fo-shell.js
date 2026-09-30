/*
 * The shell for embedded FabOrchestrator pages.
 *
 * Added to FabOrchestrator's own documents by the gateway
 * (`lib/gateway/html-inject.ts`). It contributes two things, neither of them
 * visible:
 *
 *   · the single-sign-out watcher, which ends this app's session when
 *     FabOrchestrator ends its own
 *   · the PWA service-worker registration
 *
 * ── It adds no navigation (11 September) ────────────────────────────────────
 * From WP6 until 11 September this file also injected navigation — a floating
 * hamburger, then a Back arrow, then both — because below 768px
 * FabOrchestrator hid its sidebar in a closed drawer with nothing on screen to
 * open it, and hid its header's links with nothing in their place. That was
 * FabOrchestrator's responsive defect, and it is now fixed in FabOrchestrator
 * itself: a slim bar holding its own `SidebarTrigger` on the chat and modeling
 * pages, and a menu button in its own header on the cockpit and Reports. So the
 * controls, the keyboard-shortcut driver and the corner-measuring logic are
 * gone, and this app keeps no navigation of its own. The history is in
 * `docs/STATUS.md`.
 */

(function () {
  "use strict";

  /* ── Single sign-OUT, the other half of the WP2 bridge ──────────────────
   *
   * WP2 made one sign-in serve both applications: this app's form obtains
   * FabOrchestrator's token, keeps it in an httpOnly cookie, and injects it on
   * every forwarded call. Nothing did the reverse. When **FabOrchestrator**
   * decided the session was over, this app went on holding a cookie for a
   * session that no longer existed.
   *
   * That is a redirect loop, not just untidiness. FabOrchestrator's guards
   * navigate to `/` meaning "go to our login page"; on this origin `/` is the
   * front door and sends a signed-in operator to `/home`; FabOrchestrator's
   * guard runs again. Round and round.
   *
   * `expiredUpstream()` in the gateway already clears the cookie on any upstream
   * 401, which covers every case where FabOrchestrator is *asked* something. It
   * cannot cover the one that matters most here: **FabOrchestrator's idle timer
   * clears its own storage after 30 minutes without making a request at all**,
   * so no 401 is ever produced and the cookie outlives the session in silence.
   *
   * This closes it at the only place both facts are visible — inside a
   * FabOrchestrator document, where its token either is or is not in
   * localStorage. If it is gone, this app's session is over too, and the
   * operator belongs at the sign-in form rather than in a loop.
   *
   * The loop's midpoint is always a FabOrchestrator document, which is exactly
   * where this runs — so it is broken on the first pass rather than bounded by
   * a counter.
   */
  var FO_TOKEN_KEY = "llmatscale_auth_token";
  var FO_SESSION_KEY = "llmatscale_auth_session";
  var signingOut = false;
  var reloading = false;
  /* The bearer this page loaded under, once FabOrchestrator has booted. */
  var known = null;
  /* Storage that cannot be read (private mode, blocked cookies): never a
   * reason to sign out or reload on a guess. */
  var UNREADABLE = {};

  function tokenNow() {
    try {
      return window.localStorage.getItem(FO_TOKEN_KEY);
    } catch (_error) {
      return UNREADABLE;
    }
  }

  /* ── A re-sign-in in another tab replaces the token: reload, don't stay ──
   *
   * FabOrchestrator's chat builds its request transport once, when the page
   * loads, with the bearer it found in localStorage then. A sign-in in another
   * tab writes a new bearer beside a new cookie, and this page would keep
   * sending the old one: the gateway refuses it, and FabOrchestrator's fetch
   * wrapper treats any authenticated 401 as "the session expired" and wipes
   * the shared localStorage — taking the new session down with it (review of
   * c193e9e, 30 September 2026, blocking issue 1). So a token that *changes*
   * to a different, present value means a newer session on this browser, and
   * this page reloads to pick it up before it can send the old one. A token
   * that *disappears* still means sign-out, below. */
  function reloadForNewSession() {
    if (reloading || signingOut) return;
    reloading = true;
    try {
      window.location.reload();
    } catch (_error) {
      /* Never worth an error on FabOrchestrator's page. */
    }
  }

  /* Set once FabOrchestrator has had its 4 s to boot: only then does a missing
   * token mean sign-out. A replacement counts from the moment this runs. */
  var booted = false;

  /* One look at the token: gone → sign out; replaced → reload; else remember. */
  function checkToken() {
    var token = tokenNow();
    if (token === UNREADABLE) return;
    if (!token) {
      // A page already on its way to a reload posts no sign-out: the token it
      // sees missing may be FO's wrapper reacting to this page's own stale
      // request, and the reloaded page will judge for itself (RP2-D14).
      if (booted && !reloading) endSession();
      return;
    }
    if (known && token !== known) return reloadForNewSession();
    known = token;
  }

  /* The baseline for "replaced" is the token this page loaded with, read now,
   * before FabOrchestrator boots and builds its transport from the same value.
   * Read only at the first check, a sign-in in another tab during those first
   * seconds would become the baseline instead of a replacement, and this page
   * would stay armed with the old bearer (delta review RP2-D13). Absent or
   * unreadable: no baseline yet; the first check adopts what is there. */
  (function () {
    var token = tokenNow();
    if (token !== UNREADABLE && token) known = token;
  })();

  /* Sign-in, returning to this page afterwards: FabOrchestrator's idle expiry
   * lands the operator back where they were once they sign in again. Only a
   * plain path on this origin is carried; the sign-in page validates it too. */
  function signInTarget() {
    try {
      var path = window.location.pathname;
      var search = window.location.search || "";
      if (typeof path === "string" && path.charAt(0) === "/" && path.charAt(1) !== "/" && path !== "/") {
        return "/login?next=" + encodeURIComponent(path + search);
      }
    } catch (_error) {
      /* fall through */
    }
    return "/login";
  }

  /* The plan's client order (RP2 `endClientSession`, mirrored from
   * `lib/end-client-session.ts`): tell the server, forget this device's
   * session, then a whole-document navigation to sign-in. Nothing waits on the
   * network: the request is `keepalive`, so it survives the navigation. */
  function endSession() {
    if (signingOut) return;
    signingOut = true;
    try {
      fetch("/api/pwa/auth/logout", {
        method: "POST",
        keepalive: true,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "fo_signed_out" }),
      }).catch(function () {});
    } catch (_error) {
      /* the navigation below still happens */
    }
    try {
      window.localStorage.removeItem(FO_TOKEN_KEY);
      window.localStorage.removeItem(FO_SESSION_KEY);
    } catch (_error) {
      /* nothing to remove, or nothing can be removed */
    }
    try {
      window.location.replace(signInTarget());
    } catch (_error) {
      /* Never worth an error on FabOrchestrator's page. */
    }
  }

  function watchSession() {
    // Another tab signing out, or signing in again, and coming back to a
    // backgrounded tab, are all cheaper to catch than to wait 1.5s for. Both
    // listen from the start: a replacement is a replacement whenever it lands.
    // A removal before FabOrchestrator has booted is left to the first check.
    window.addEventListener("storage", function (e) {
      if (e.key !== FO_TOKEN_KEY) return;
      if (!e.newValue) {
        if (booted && !reloading) endSession();
        return;
      }
      if (known && e.newValue !== known) reloadForNewSession();
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) checkToken();
    });
    // Not on the first tick: FabOrchestrator writes its token during its own
    // boot, and reading before it has finished would sign out a session that is
    // in the middle of starting.
    setTimeout(function () {
      booted = true;
      checkToken();
      if (signingOut || reloading) return;
      setInterval(checkToken, 1500);
    }, 4000);
  }

  try {
    watchSession();
  } catch (_error) {
    /* Never worth an error on FabOrchestrator's page. */
  }

  /* ── The service worker, registered from FabOrchestrator's pages too ────
   *
   * This app registers `/sw.js` from `components/register-sw.tsx`, which is
   * rendered by **this app's** layout — so it runs on `/login` and nowhere
   * else an operator normally goes. In practice that is enough, because the
   * session gate makes every signed-out visitor pass through `/login` first,
   * and the registration's scope is `/`, so the worker it leaves behind
   * controls FabOrchestrator's pages afterwards. Measured on the deployment:
   * active, scope `/`, and controlling `/home`, `/chat` and `/reports`.
   *
   * "In practice" is doing work in that sentence, though. An operator who is
   * already signed in and opens `/home` directly — a shared link, a home-screen
   * shortcut, a restored tab — never touches `/login`, and if their site data
   * was cleared in the meantime there is no worker and nothing to register it.
   * They would get a working app with no offline page and no installability
   * until they happened to sign out.
   *
   * So the registration is repeated here, where it runs on every
   * FabOrchestrator document. `register()` on an already-registered scope is
   * a no-op that resolves to the existing registration, so the normal path
   * costs nothing.
   */
  try {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("/sw.js").catch(function () {
          /* A browser that will not register one still gets the whole app. */
        });
      });
    }
  } catch (_error) {
    /* Never worth an error on FabOrchestrator's page. */
  }
})();
