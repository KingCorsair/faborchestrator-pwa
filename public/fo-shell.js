/*
 * The shell for embedded FabOrchestrator pages.
 *
 * Added to FabOrchestrator's own documents by the gateway
 * (`lib/gateway/html-inject.ts`). It contributes four things:
 *
 *   · the single-sign-out watcher, which ends this app's session when
 *     FabOrchestrator ends its own
 *   · the PWA service-worker registration
 *   · for device administrators only, a Devices button that opens this app's
 *     own `/device-admin` (13 October; see "The Devices button" below)
 *   · on a phone's conversation pages, a Back arrow to FabOrchestrator's
 *     overview, where FabOrchestrator shows none (13 October; see "Back, on a
 *     phone's conversation pages" at the end)
 *
 * ── It adds no FabOrchestrator navigation (11 September) ────────────────────
 * From WP6 until 11 September this file also injected navigation — a floating
 * hamburger, then a Back arrow, then both — because below 768px
 * FabOrchestrator hid its sidebar in a closed drawer with nothing on screen to
 * open it, and hid its header's links with nothing in their place. That was
 * FabOrchestrator's responsive defect, and it is now fixed in FabOrchestrator
 * itself: a slim bar holding its own `SidebarTrigger` on the chat and modeling
 * pages, and a menu button in its own header on the cockpit and Reports. So the
 * controls, the keyboard-shortcut driver and the corner-measuring logic are
 * gone, and this app keeps no navigation of its own. The history is in
 * `docs/STATUS.md`. That fix lived in the private build; the newer deployment
 * served since 13 October has no way back on a phone's conversation pages, so
 * the Back arrow returns there (the end of this file).
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

  /* ── The Devices button, for device administrators ──────────────────────
   *
   * (13 October 2026.) Approved devices are this app's feature, managed at its
   * own page, `/device-admin`: enrollment QR codes, the device list,
   * revocation. FabOrchestrator knows nothing about any of it. The way in used
   * to be a button patched into a private build of FabOrchestrator's top bar,
   * which tied this app to that one build of FabOrchestrator's pages; when
   * FabOrchestrator moved on, the pages and the service behind them no longer
   * matched (tool results failed to display). The button is this app's, so it
   * is drawn by this app, here, and FabOrchestrator's pages are served as
   * FabOrchestrator builds them.
   *
   * It is a link and nothing more. Whether to show it is the answer to the
   * question the old button asked, `GET /api/pwa/device-admin/me`: an approved
   * device, a valid session of this app and an email on DEVICE_ADMIN_EMAILS,
   * all checked on the server. Anyone else is answered 403 and sees no
   * button. Showing it grants nothing: `/device-admin` and every action on it
   * make the same check again for themselves.
   *
   * On FabOrchestrator's overview page only, where the old button was. It is
   * placed with its own styles and attached to <body>, so it depends on
   * nothing in FabOrchestrator's markup. */
  var DEVICES_PAGE = "/device-admin";
  var DEVICES_SHOWN_ON = ["/home"];
  var devicesButton = null;
  var devicesAsked = false;

  function onDevicesPage() {
    try {
      return DEVICES_SHOWN_ON.indexOf(window.location.pathname) !== -1;
    } catch (_error) {
      return false;
    }
  }

  /* Attached once the page has a body, re-attached if a re-render drops it,
   * and shown only on the overview page: FabOrchestrator moves between some
   * of its pages without a reload. */
  function placeDevicesButton() {
    if (!devicesButton) return;
    try {
      if (!document.body) return;
      if (devicesButton.parentNode !== document.body) document.body.appendChild(devicesButton);
      devicesButton.style.display = onDevicesPage() && !signingOut ? "inline-flex" : "none";
    } catch (_error) {
      /* Never worth an error on FabOrchestrator's page. */
    }
  }

  function askDevices() {
    if (devicesAsked || signingOut) return;
    if (typeof document.createElement !== "function") return;
    var token = tokenNow();
    if (token === UNREADABLE || !token) return; // no session yet: the next tick asks
    devicesAsked = true;
    fetch(DEVICES_PAGE_CHECK, {
      headers: { Authorization: "Bearer " + token },
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(function (res) {
        // 403: not a device administrator. Asked once per page; no button.
        if (!res || !res.ok) return;
        var link = document.createElement("a");
        link.id = "pwa-devices-link";
        link.href = DEVICES_PAGE;
        link.textContent = "Devices";
        link.setAttribute("aria-label", "Manage approved devices");
        link.style.cssText =
          "position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));" +
          "z-index:2147483000;display:none;align-items:center;padding:11px 18px;border-radius:999px;" +
          "background:#ffffff;color:#3b34c4;border:1px solid #d9dcef;box-shadow:0 6px 20px rgba(16,21,58,.18);" +
          "font:600 14px/1 system-ui,-apple-system,'Segoe UI',sans-serif;text-decoration:none;";
        devicesButton = link;
        placeDevicesButton();
      })
      .catch(function () {
        devicesAsked = false; // the network: ask again on the next tick
      });
  }
  var DEVICES_PAGE_CHECK = "/api/pwa/device-admin/me";

  try {
    askDevices();
    setInterval(function () {
      askDevices();
      placeDevicesButton();
    }, 1500);
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

  /* ── Back, on a phone's conversation pages (13 October 2026) ─────────────
   *
   * Below 768px FabOrchestrator's chat and Master Data Load pages, as the
   * newer deployment serves them, offer no way back to its overview: the
   * sidebar that carries "Back to overview" is a closed drawer with nothing
   * on screen to open it. The private build these pages used to come from
   * had a phone bar holding the sidebar's own Back (`docs/STATUS.md` v6), and
   * until 11 September this file drew a Back arrow (v19). So the arrow is back
   * with v19's label, title, glyph and destination (`/home`), below 768px, on
   * conversation pages only. It steps aside whenever FabOrchestrator shows a
   * Back of its own on screen.
   *
   * Where it sits: v19 drew it top-right, which on the newer chat covers its
   * "MCP/DB Health" badge. So it takes the top-left corner, and if
   * FabOrchestrator draws something there, the top-right. It is placed when a
   * page opens (again shortly after, once FabOrchestrator has drawn that page)
   * and on rotation, never while the operator scrolls, so it does not hop
   * about. Started on `load`, so it never meets FabOrchestrator's hydration.
   */
  var BACK_ID = "pwa-fo-back";
  var BACK_LABEL = "Back to FabOrchestrator overview";
  var BACK_SIZE = 40;
  var BACK_GAP = 8;
  var phoneWidth = null;
  try {
    phoneWidth = window.matchMedia ? window.matchMedia("(max-width: 767.98px)") : null;
  } catch (_error) {
    phoneWidth = null;
  }
  /* The page and width the arrow was last placed for, and when to look again. */
  var backPlacedFor = "";
  var backRecheckAt = [];

  function conversationPage() {
    var p = window.location.pathname || "";
    return p === "/chat" || p.indexOf("/chat/") === 0 || p.indexOf("/modeling-agent") === 0;
  }

  /* FabOrchestrator's own Back, visible on screen (not in a closed drawer). */
  function foShowsItsOwnBack() {
    var own = document.querySelectorAll('[aria-label="' + BACK_LABEL + '"]');
    for (var i = 0; i < own.length; i++) {
      if (own[i].id === BACK_ID) continue;
      var r = own[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth) return true;
    }
    return false;
  }

  /* Something of FabOrchestrator's that a person sees or taps at (x, y): a
   * control, an icon, the letters of a line of text (not the empty rest of
   * the box that holds them), or a small box with a background, border or
   * shadow (a badge). Plain layout boxes and page-wide bars do not count. */
  var INTERACTIVE_ROLES = /^(button|link|tab|switch|checkbox|radio|menuitem|combobox|textbox|option|img)$/;

  function drawn(el, vw, vh, x, y) {
    var tag = (el.tagName || "").toLowerCase();
    if (/^(a|button|input|textarea|select|label|img|svg|canvas|video|path|circle|rect|polyline|line|use)$/.test(tag)) return true;
    var role = el.getAttribute ? el.getAttribute("role") : null;
    if (role && INTERACTIVE_ROLES.test(role)) return true;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 3 || !/\S/.test(n.nodeValue) || !document.createRange) continue;
      var range = document.createRange();
      range.selectNodeContents(n);
      var lines = range.getClientRects();
      for (var k = 0; k < lines.length; k++) {
        var t = lines[k];
        if (x >= t.left - 2 && x <= t.right + 2 && y >= t.top - 2 && y <= t.bottom + 2) return true;
      }
    }
    var r = el.getBoundingClientRect();
    if (r.width < vw * 0.7 && r.height < vh * 0.3) {
      var cs = window.getComputedStyle(el);
      var bg = cs.backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bg)) return true;
      if (parseFloat(cs.borderTopWidth) > 0 || (cs.boxShadow && cs.boxShadow !== "none")) return true;
    }
    return false;
  }

  /* Is anything of FabOrchestrator's drawn where the arrow would go? */
  function cornerTaken(left, top) {
    if (!document.elementsFromPoint) return false;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var points = [
      [left + 3, top + 3],
      [left + BACK_SIZE - 3, top + 3],
      [left + 3, top + BACK_SIZE - 3],
      [left + BACK_SIZE - 3, top + BACK_SIZE - 3],
      [left + BACK_SIZE / 2, top + BACK_SIZE / 2],
    ];
    for (var i = 0; i < points.length; i++) {
      var found = document.elementsFromPoint(points[i][0], points[i][1]);
      for (var j = 0; j < found.length; j++) {
        var el = found[j];
        if (el === document.documentElement || el === document.body) continue;
        if (el.closest && el.closest("#" + BACK_ID + ",#pwa-devices-link")) continue;
        if (drawn(el, vw, vh, points[i][0], points[i][1])) return true;
      }
    }
    return false;
  }

  function makeBackButton() {
    var b = document.createElement("button");
    b.id = BACK_ID;
    b.type = "button";
    b.title = "Back to overview";
    b.setAttribute("aria-label", BACK_LABEL);
    b.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/>' +
      '<polyline points="12 19 5 12 12 5"/></svg>';
    b.style.cssText = [
      "position:fixed",
      "top:calc(env(safe-area-inset-top, 0px) + " + BACK_GAP + "px)",
      "left:calc(env(safe-area-inset-left, 0px) + " + BACK_GAP + "px)",
      "z-index:40",
      "display:none",
      "align-items:center",
      "justify-content:center",
      "width:" + BACK_SIZE + "px",
      "height:" + BACK_SIZE + "px",
      "padding:0",
      "border:1px solid rgba(15,23,42,.08)",
      "border-radius:10px",
      "background:rgba(255,255,255,.78)",
      "-webkit-backdrop-filter:blur(8px)",
      "backdrop-filter:blur(8px)",
      "color:#475569",
      "box-shadow:0 2px 8px rgba(16,21,58,.10)",
      "cursor:pointer",
      "-webkit-tap-highlight-color:transparent",
    ].join(";");
    b.addEventListener("click", function () {
      // FabOrchestrator's page, not this app's; this script has no Next router.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/home");
    });
    document.body.appendChild(b);
    return b;
  }

  /* Top-left, unless FabOrchestrator has something there and not top-right. */
  function chooseCorner(b) {
    var top = b.getBoundingClientRect().top;
    var leftX = BACK_GAP;
    var rightX = window.innerWidth - BACK_SIZE - BACK_GAP;
    var useRight = cornerTaken(leftX, top) && !cornerTaken(rightX, top);
    b.style.left = useRight ? "auto" : "calc(env(safe-area-inset-left, 0px) + " + BACK_GAP + "px)";
    b.style.right = useRight ? "calc(env(safe-area-inset-right, 0px) + " + BACK_GAP + "px)" : "auto";
    b.setAttribute("data-corner", useRight ? "top-right" : "top-left");
  }

  function placeBackButton() {
    try {
      var wanted = !!(phoneWidth && phoneWidth.matches) && conversationPage() && !signingOut && !foShowsItsOwnBack();
      var b = document.getElementById(BACK_ID);
      if (!wanted) {
        if (b) b.style.display = "none";
        backPlacedFor = "";
        return;
      }
      if (!b) b = makeBackButton();
      b.style.display = "flex";
      var now = Date.now();
      var key = window.location.pathname + "|" + window.innerWidth;
      if (key !== backPlacedFor) {
        backPlacedFor = key;
        backRecheckAt = [now + 1200, now + 3000];
        chooseCorner(b);
      } else if (backRecheckAt.length && now >= backRecheckAt[0]) {
        backRecheckAt.shift();
        chooseCorner(b);
      }
    } catch (_error) {
      /* Never worth an error on FabOrchestrator's page. */
    }
  }

  /* FabOrchestrator moves between its pages without reloading, so the page is
   * looked at twice a second, and at once on Back/Forward and on rotation. */
  try {
    window.addEventListener("load", function () {
      try {
        setInterval(placeBackButton, 500);
        window.addEventListener("popstate", placeBackButton);
        if (phoneWidth && phoneWidth.addEventListener) phoneWidth.addEventListener("change", placeBackButton);
      } catch (_error) {
        /* Never worth an error on FabOrchestrator's page. */
      }
    });
  } catch (_error) {
    /* Never worth an error on FabOrchestrator's page. */
  }
})();
