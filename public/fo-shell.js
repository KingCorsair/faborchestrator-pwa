/*
 * The shell for embedded FabOrchestrator pages.
 *
 * Added to FabOrchestrator's own documents by the gateway
 * (`lib/gateway/html-inject.ts`). It contributes six things:
 *
 *   · the single-sign-out watcher, which ends this app's session when
 *     FabOrchestrator ends its own
 *   · the install grant an approved browser keeps ready, so that an app added
 *     to the Home Screen from one of these pages joins the same device
 *   · the PWA service-worker registration
 *   · for device administrators only, a Devices button that opens this app's
 *     own `/device-admin` (13 October; see "The Devices button" below)
 *   · on a phone's conversation pages, a small bar with a menu button that
 *     opens FabOrchestrator's own sidebar and a Back arrow to its overview,
 *     where FabOrchestrator shows neither (13 and 16 October; see "Phone
 *     navigation on conversation pages")
 *   · on a phone, a composer "+" menu whose Connectors submenu stays on screen
 *     and answers a tap (16 October; see "The composer's '+' menu")
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
 * served since 13 October has neither on a phone's conversation pages, so the
 * menu button and the Back arrow return there (near the end of this file).
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

  /* ── A cookie this page never had the bearer for is forgotten, not ended ──
   *
   * (9 October 2026.) On an iPhone, "Add to Home Screen" copies the browser's
   * cookies into the new app and nothing else. The app then opens here with
   * the browser's session cookie and **no bearer in its storage at all**: a
   * session it never signed in with. Calling sign-out for it revoked that
   * session at FabOrchestrator, so opening the installed app signed the
   * browser out.
   *
   * The two cases are told apart by what this page has seen. `known` is the
   * bearer this page loaded with or has since seen. If there has never been
   * one, the cookie was not this context's: it is forgotten here
   * (`/api/pwa/auth/forget` clears the cookie and revokes nothing) and the
   * operator goes to sign-in. If there was one and it is now gone, that is a
   * real end of this context's own session, and it is ended as before. */
  function tokenGone() {
    if (known) endSession("/api/pwa/auth/logout", "fo_signed_out");
    else endSession("/api/pwa/auth/forget", "fo_token_missing");
  }

  /* One look at the token: gone → sign out; replaced → reload; else remember. */
  function checkToken() {
    var token = tokenNow();
    if (token === UNREADABLE) return;
    if (!token) {
      // A page already on its way to a reload posts no sign-out: the token it
      // sees missing may be FO's wrapper reacting to this page's own stale
      // request, and the reloaded page will judge for itself (RP2-D14).
      if (booted && !reloading) tokenGone();
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
   * network: the request is `keepalive`, so it survives the navigation.
   * `path` is sign-out, or forget for a cookie that was never this page's. */
  function endSession(path, reason) {
    if (signingOut) return;
    signingOut = true;
    try {
      fetch(path, {
        method: "POST",
        keepalive: true,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason }),
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
        if (booted && !reloading) tokenGone();
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

  /* ── An install grant, kept ready on FabOrchestrator's pages too ────────
   *
   * (9 October 2026; `lib/devices/install-grant.ts`.) On an iPhone the app
   * added to the Home Screen gets storage of its own, without the device key
   * its browser enrolled with, and used to need a second enrollment QR. iOS
   * does copy the browser's cookies into the new app, so an approved browser
   * keeps a one-time **install grant** among them, and the app uses it to
   * register a key of its own under the same device.
   *
   * Nothing announces "Add to Home Screen", so the grant has to be there
   * already, and an operator is on one of FabOrchestrator's pages when they
   * tap it. This is `keepInstallGrant` from `lib/devices/keystore.ts`, by
   * hand, because that module is not on these pages: read this browser's
   * device key from the same IndexedDB record, sign the server's `grant`
   * challenge with it, and let the server set the grant in an httpOnly cookie
   * this code never sees. A test holds the two copies' constants together.
   *
   * It does nothing unless this is a browser tab an app would be installed
   * from with separate storage, a device key is stored here, and the grant
   * last obtained is close to running out. A page returning to the foreground
   * always asks (`force`): an app may have used the grant meanwhile, and the
   * server then issues the next one. The server gives a grant only to the key
   * the device was enrolled with, whatever this page claims. */
  var GRANT_UNTIL_KEY = "fo_install_grant_until";
  var GRANT_RENEW_BELOW_MS = 30 * 24 * 60 * 60 * 1000;
  var GRANT_CHECK_EVERY_MS = 60 * 1000;
  var grantBusy = false;
  var grantStopped = false;

  function mayInstallSeparately() {
    try {
      var ua = String(navigator.userAgent || "");
      var standalone =
        (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) ||
        navigator.standalone === true;
      if (standalone) return false;
      if (/iPhone|iPad|iPod/.test(ua)) return true;
      if (!/Macintosh/.test(ua)) return false;
      if ((navigator.maxTouchPoints || 0) > 1) return true;
      return /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
    } catch (_error) {
      return false;
    }
  }

  function toB64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var text = "";
    for (var i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64url(text) {
    var bin = atob(String(text).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* This browser's device key record, or null. Opened the way keystore.ts
   * opens it, so a first touch here leaves the database in the same shape. */
  function readDeviceKey() {
    return new Promise(function (resolve) {
      var request;
      try {
        request = indexedDB.open("fo-device", 1);
      } catch (_error) {
        resolve(null);
        return;
      }
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains("credential")) {
          request.result.createObjectStore("credential", { keyPath: "id" });
        }
      };
      request.onerror = function () {
        resolve(null);
      };
      request.onblocked = function () {
        resolve(null);
      };
      request.onsuccess = function () {
        var db = request.result;
        try {
          var get = db.transaction("credential", "readonly").objectStore("credential").get("device");
          get.onsuccess = function () {
            db.close();
            resolve(get.result || null);
          };
          get.onerror = function () {
            db.close();
            resolve(null);
          };
        } catch (_error) {
          db.close();
          resolve(null);
        }
      };
    });
  }

  function postJson(path, body) {
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (json) {
          return { status: res.status, body: json || {} };
        });
    });
  }

  function keepInstallGrant(force) {
    if (grantBusy || grantStopped || signingOut || document.hidden) return;
    if (!mayInstallSeparately()) return;
    if (typeof indexedDB === "undefined" || typeof crypto === "undefined" || !crypto.subtle) return;
    var until = 0;
    try {
      until = Number(window.localStorage.getItem(GRANT_UNTIL_KEY)) || 0;
    } catch (_error) {
      /* unreadable: ask, and the server keeps a grant that is still fresh */
    }
    if (force !== true && until - Date.now() > GRANT_RENEW_BELOW_MS) return;

    grantBusy = true;
    readDeviceKey()
      .then(function (record) {
        if (!record || !record.deviceId || !record.privateKey || typeof record.publicKeySpki !== "string") return null;
        return crypto.subtle.digest("SHA-256", fromB64url(record.publicKeySpki)).then(function (digest) {
          var bytes = new Uint8Array(digest);
          var credentialId = "";
          for (var i = 0; i < 16; i += 1) credentialId += ("0" + bytes[i].toString(16)).slice(-2);
          var who = { deviceId: record.deviceId, credentialId: credentialId };
          return postJson("/api/pwa/device-auth/challenge", { deviceId: who.deviceId, credentialId: credentialId, purpose: "grant" }).then(
            function (challenge) {
              // Refused: not the enrolling key, or no longer approved. Stop asking.
              if (challenge.status === 403 || challenge.status === 404) {
                grantStopped = true;
                return null;
              }
              if (challenge.status !== 200 || !challenge.body.challenge || !challenge.body.challengeId) return null;
              return crypto.subtle
                .sign({ name: "ECDSA", hash: "SHA-256" }, record.privateKey, fromB64url(challenge.body.challenge))
                .then(function (signature) {
                  return postJson("/api/pwa/device-credentials/grant", {
                    deviceId: who.deviceId,
                    credentialId: credentialId,
                    challengeId: challenge.body.challengeId,
                    signature: toB64url(signature),
                  });
                })
                .then(function (grant) {
                  if (grant.status === 403 || grant.status === 404) {
                    grantStopped = true;
                    return null;
                  }
                  if (grant.status !== 200 || !grant.body.expiresAt) return null;
                  try {
                    window.localStorage.setItem(GRANT_UNTIL_KEY, String(new Date(grant.body.expiresAt).getTime()));
                  } catch (_error) {
                    /* the next page asks again */
                  }
                  return null;
                });
            },
          );
        });
      })
      .catch(function () {
        /* the network, or storage: the next tick tries again */
      })
      .then(function () {
        grantBusy = false;
      });
  }

  try {
    keepInstallGrant(false);
    document.addEventListener("visibilitychange", function () {
      keepInstallGrant(true);
    });
    setInterval(function () {
      keepInstallGrant(false);
    }, GRANT_CHECK_EVERY_MS);
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

  /* ── Phone navigation on conversation pages: menu and Back ───────────────
   *
   * (13 October 2026, the menu added 16 October.) Below 768px the newer
   * deployment's chat and Master Data Load pages keep their sidebar — the
   * agent's chats, New chat, Projects, FO Overview, Agents, Settings — in a
   * closed drawer with nothing on screen to open it, and offer no way back to
   * the overview. The private build these pages used to come from had a phone
   * bar for both (`docs/STATUS.md` v6); until 11 September this file drew a
   * hamburger and a Back arrow (v20). Both are back, side by side in one small
   * bar:
   *
   *   menu  opens FabOrchestrator's own drawer by its own shortcut (Ctrl+B,
   *         which its sidebar toggles on, and which on a phone opens the
   *         drawer). Nothing of FabOrchestrator's is reached into or copied;
   *         shown only where the page has that sidebar (data-slot
   *         "sidebar-wrapper").
   *   Back  v19's label, title, glyph and destination (`/home`).
   *
   * The bar steps aside whenever FabOrchestrator shows a Back of its own on
   * screen, which is also the case while the drawer is open.
   *
   * Where it sits: top-right covers the newer chat's "MCP/DB Health" badge, so
   * the top-left corner, and if FabOrchestrator draws something there, the
   * top-right. It is placed when a page opens (again shortly after, once
   * FabOrchestrator has drawn that page) and on rotation, never while the
   * operator scrolls, so it does not hop about. Started on `load`, so it never
   * meets FabOrchestrator's hydration.
   */
  var NAV_ID = "pwa-fo-nav";
  var MENU_ID = "pwa-fo-sidebar-toggle";
  var BACK_ID = "pwa-fo-back";
  var BACK_LABEL = "Back to FabOrchestrator overview";
  var NAV_GAP = 8;
  var phoneWidth = null;
  try {
    phoneWidth = window.matchMedia ? window.matchMedia("(max-width: 767.98px)") : null;
  } catch (_error) {
    phoneWidth = null;
  }
  /* The page and width the bar was last placed for, and when to look again. */
  var navPlacedFor = "";
  var navRecheckAt = [];

  function conversationPage() {
    var p = window.location.pathname || "";
    return p === "/chat" || p.indexOf("/chat/") === 0 || p.indexOf("/modeling-agent") === 0;
  }

  /* FabOrchestrator's own sidebar is on this page (open or not). */
  function pageHasSidebar() {
    return !!document.querySelector('[data-slot="sidebar-wrapper"]');
  }

  /* FabOrchestrator's own Back, visible on screen (not in a closed drawer). */
  function foShowsItsOwnBack() {
    var own = document.querySelectorAll('[aria-label="' + BACK_LABEL + '"]');
    for (var i = 0; i < own.length; i++) {
      if (own[i].closest && own[i].closest("#" + NAV_ID)) continue;
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

  /* Is anything of FabOrchestrator's drawn in the box the bar would take?
   * Sampled on a grid across the whole box (three rows, seven columns), so a
   * heading that only reaches into its lower edge still counts. */
  function cornerTaken(left, top, width, height) {
    if (!document.elementsFromPoint) return false;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var points = [];
    var rows = [top + 3, top + height / 2, top + height - 3];
    for (var ri = 0; ri < rows.length; ri++) {
      for (var ci = 0; ci <= 6; ci++) points.push([left + 3 + ((width - 6) * ci) / 6, rows[ri]]);
    }
    for (var i = 0; i < points.length; i++) {
      var found = document.elementsFromPoint(points[i][0], points[i][1]);
      for (var j = 0; j < found.length; j++) {
        var el = found[j];
        if (el === document.documentElement || el === document.body) continue;
        if (el.closest && el.closest("#" + NAV_ID + ",#pwa-devices-link")) continue;
        if (drawn(el, vw, vh, points[i][0], points[i][1])) return true;
      }
    }
    return false;
  }

  function navButton(id, label, title, svg) {
    var b = document.createElement("button");
    b.id = id;
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", label);
    b.innerHTML = svg;
    b.style.cssText = [
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "width:44px",
      "height:40px",
      "margin:0",
      "padding:0",
      "border:0",
      "background:transparent",
      "color:#334155",
      "cursor:pointer",
      "-webkit-tap-highlight-color:transparent",
    ].join(";");
    return b;
  }

  /* Opens FabOrchestrator's drawer the way its own shortcut does. */
  function openSidebar() {
    try {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    } catch (_error) {
      /* Never worth an error on FabOrchestrator's page. */
    }
  }

  function makeNav() {
    var nav = document.createElement("div");
    nav.id = NAV_ID;
    nav.setAttribute("role", "navigation");
    nav.setAttribute("aria-label", "FabOrchestrator");
    nav.style.cssText = [
      "position:fixed",
      "top:calc(env(safe-area-inset-top, 0px) + " + NAV_GAP + "px)",
      "left:calc(env(safe-area-inset-left, 0px) + " + NAV_GAP + "px)",
      "z-index:40",
      "display:none",
      "align-items:center",
      "height:40px",
      "border:1px solid rgba(15,23,42,.08)",
      "border-radius:12px",
      "background:rgba(255,255,255,.86)",
      "-webkit-backdrop-filter:blur(8px)",
      "backdrop-filter:blur(8px)",
      "box-shadow:0 2px 10px rgba(16,21,58,.10)",
      "overflow:hidden",
    ].join(";");
    var menu = navButton(
      MENU_ID,
      "Open menu",
      "Menu",
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    );
    menu.addEventListener("click", openSidebar);
    var divider = document.createElement("span");
    divider.setAttribute("aria-hidden", "true");
    divider.setAttribute("data-pwa-nav-divider", "");
    divider.style.cssText = "width:1px;height:20px;background:rgba(15,23,42,.12);flex:none";
    var back = navButton(
      BACK_ID,
      BACK_LABEL,
      "Back to overview",
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/>' +
        '<polyline points="12 19 5 12 12 5"/></svg>',
    );
    back.addEventListener("click", function () {
      // FabOrchestrator's page, not this app's; this script has no Next router.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/home");
    });
    nav.appendChild(menu);
    nav.appendChild(divider);
    nav.appendChild(back);
    document.body.appendChild(nav);
    return nav;
  }

  /* Top-left, unless FabOrchestrator has something there and not top-right. */
  function chooseCorner(nav) {
    var r = nav.getBoundingClientRect();
    var leftX = NAV_GAP;
    var rightX = window.innerWidth - r.width - NAV_GAP;
    var useRight = cornerTaken(leftX, r.top, r.width, r.height) && !cornerTaken(rightX, r.top, r.width, r.height);
    nav.style.left = useRight ? "auto" : "calc(env(safe-area-inset-left, 0px) + " + NAV_GAP + "px)";
    nav.style.right = useRight ? "calc(env(safe-area-inset-right, 0px) + " + NAV_GAP + "px)" : "auto";
    nav.setAttribute("data-corner", useRight ? "top-right" : "top-left");
  }

  function placeNav() {
    try {
      var wanted = !!(phoneWidth && phoneWidth.matches) && conversationPage() && !signingOut && !foShowsItsOwnBack();
      var nav = document.getElementById(NAV_ID);
      if (!wanted) {
        if (nav) nav.style.display = "none";
        navPlacedFor = "";
        return;
      }
      if (!nav) nav = makeNav();
      var withMenu = pageHasSidebar();
      var menu = document.getElementById(MENU_ID);
      var divider = nav.querySelector("[data-pwa-nav-divider]");
      if (menu) menu.style.display = withMenu ? "flex" : "none";
      if (divider) divider.style.display = withMenu ? "block" : "none";
      nav.style.display = "flex";
      var now = Date.now();
      // The query too: FabOrchestrator switches between a chat and its reports
      // on the same path (`?view=dashboards`, `&d=`), and those pages differ.
      var key = window.location.pathname + window.location.search + "|" + window.innerWidth + "|" + withMenu;
      if (key !== navPlacedFor) {
        navPlacedFor = key;
        navRecheckAt = [now + 1200, now + 3000];
        chooseCorner(nav);
      } else if (navRecheckAt.length && now >= navRecheckAt[0]) {
        navRecheckAt.shift();
        chooseCorner(nav);
      }
    } catch (_error) {
      /* Never worth an error on FabOrchestrator's page. */
    }
  }

  /* ── The composer's menus, usable with a thumb (16 October 2026) ─────────
   *
   * Two of the newer deployment's composer menus have a submenu that cannot
   * be used on a phone: the "+" menu's **Connectors** and the model picker's
   * **More models**. Both are built the same way:
   *
   *   1. The row opens its submenu on hover (onMouseEnter) *and* toggles it on
   *      tap (onClick). A tap delivers both: Chrome on Android opens the
   *      submenu and closes it again within the same tap; Safari takes the
   *      hover as the whole tap, so it opens and the row cannot close it.
   *   2. The submenu is pinned beside its menu (`left-full`), off the side of a
   *      phone's screen.
   *
   * So touch-made hover never reaches those two menus (their rows answer the
   * tap alone, as buttons do; a mouse still hovers as before), and below
   * 768px a stylesheet places each submenu above the row that opens it, inside
   * the screen, with the "+" menu's rows 44px tall. A tap anywhere on a
   * connector's row flips its switch, not only on the switch itself. Matched
   * by FabOrchestrator's own class names and switch ids; where they are
   * absent, nothing here does anything.
   */
  var PLUS_MENU = '[class~="bottom-full"][class~="w-[220px]"]';
  var MODEL_MENU = '[class~="bottom-full"][class~="right-0"][class~="w-[260px]"]';
  /* FabOrchestrator's Settings window: a 240px menu column beside the content. */
  var SETTINGS = '[class~="max-w-[820px]"][class~="h-[min(640px,88vh)]"]';
  var SETTINGS_MENU = SETTINGS + '>[class~="w-[240px]"]';
  var SETTINGS_BODY = SETTINGS + '>[class~="min-w-0"]';
  /* The reports list's header row, which ends in the time-zone picker. */
  var REPORTS_HEAD = '[class~="mb-[18px]"][class~="items-center"][class~="gap-[11px]"]:has(>[class~="ml-auto"])';
  /* A report page's title block, beside its Refresh / Download / Remove. */
  var REPORT_TITLE =
    '[class~="mb-[18px]"][class~="flex-wrap"][class~="items-end"]>[class~="min-w-0"][class~="flex-1"]';
  var CONNECTOR_SWITCH = 'button[role="switch"][id^="mcp-plus-"]';
  var MOBILE_STYLE_ID = "pwa-fo-mobile-style";
  var MOBILE_CSS =
    "@media (max-width: 767.98px) {" +
    // Connectors: above its row, from the "+" menu's left edge.
    '[class~="left-full"][class~="w-[300px]"][class~="ml-1"]{' +
    "left:0!important;right:auto!important;bottom:calc(100% + 6px)!important;margin-left:0!important;" +
    "width:min(300px,calc(100vw - 72px))!important}" +
    // More models: above its row, from the model picker's right edge.
    '[class~="left-full"][class~="top-0"][class~="w-[260px]"][class~="ml-1"]{' +
    "left:auto!important;right:0!important;top:auto!important;bottom:calc(100% + 6px)!important;" +
    "margin-left:0!important;width:min(260px,calc(100vw - 32px))!important}" +
    PLUS_MENU + ">button," + PLUS_MENU + '>div[class~="relative"]>button{min-height:44px}' +
    // A report's header (its title, then Refresh / Download / Remove): the
    // title block takes the whole first line and the buttons wrap below it,
    // and a long title wraps instead of ending in "…".
    REPORT_TITLE + "{flex:1 1 100%!important}" +
    // The reports list's header ("Recent Reports", N PINNED, the time-zone
    // picker) wraps, and the picker takes a line of its own.
    REPORTS_HEAD + "{flex-wrap:wrap!important;row-gap:10px}" +
    REPORTS_HEAD + '>[class~="ml-auto"]{flex:1 1 100%!important;margin-left:0!important}' +
    // The Settings window: the menu becomes one row of tabs across the top
    // (swiped sideways when it is wider than the screen), the content takes
    // the full width below it, and the close button sits in the window's
    // top-right corner.
    SETTINGS + "{flex-direction:column!important;position:relative!important;height:min(88dvh,720px)!important}" +
    SETTINGS_MENU + "{width:auto!important;flex:none!important;border-right:0!important;" +
    "border-bottom:1px solid var(--border,rgba(15,23,42,.1))!important;padding:12px 12px 8px!important}" +
    SETTINGS_MENU + ">h2{margin:0 0 8px!important;padding:4px 44px 0 4px!important}" +
    SETTINGS_MENU + ">nav{flex-direction:row!important;overflow-x:auto!important;gap:6px!important;" +
    "scrollbar-width:none;-webkit-overflow-scrolling:touch;padding-bottom:2px}" +
    SETTINGS_MENU + ">nav::-webkit-scrollbar{display:none}" +
    SETTINGS_MENU + ">nav>button{flex:none!important;white-space:nowrap!important;padding:8px 12px!important}" +
    // Stacked, the content must be allowed to be shorter than what it holds,
    // so it scrolls inside the window instead of running out of its bottom.
    SETTINGS + "{overflow:hidden!important}" +
    SETTINGS_BODY + "{min-height:0!important}" +
    SETTINGS_BODY + '>[class~="justify-end"]{position:absolute!important;top:8px;right:8px;padding:0!important;z-index:1}' +
    SETTINGS_BODY + '>[class~="overflow-y-auto"]{padding:12px 16px 16px!important}' +
    REPORT_TITLE + '>h1[class~="truncate"]{white-space:normal!important;overflow:visible!important;' +
    "text-overflow:clip!important;overflow-wrap:anywhere}" +
    "}";

  function addMobileStyle() {
    if (document.getElementById(MOBILE_STYLE_ID) || !document.head) return;
    var style = document.createElement("style");
    style.id = MOBILE_STYLE_ID;
    style.textContent = MOBILE_CSS;
    document.head.appendChild(style);
  }

  var lastPointerType = "";
  var lastPointerAt = 0;

  function touchJustNow() {
    return lastPointerType === "touch" && Date.now() - lastPointerAt < 1000;
  }

  try {
    window.addEventListener(
      "pointerdown",
      function (e) {
        lastPointerType = e.pointerType || "";
        lastPointerAt = Date.now();
      },
      true,
    );
    ["mouseover", "mouseout"].forEach(function (type) {
      window.addEventListener(
        type,
        function (e) {
          var t = e.target;
          if (touchJustNow() && t && t.closest && t.closest(PLUS_MENU + "," + MODEL_MENU)) e.stopPropagation();
        },
        true,
      );
    });
    document.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest || t.closest('[role="switch"]')) return;
      for (var el = t, depth = 0; el && depth < 4; el = el.parentElement, depth++) {
        var sw = el.querySelector && el.querySelector(":scope > " + CONNECTOR_SWITCH);
        if (sw) {
          sw.click();
          return;
        }
      }
    });
  } catch (_error) {
    /* Never worth an error on FabOrchestrator's page. */
  }

  /* Settings opened from the user menu at the foot of the drawer leaves the
   * drawer open on top of it, and the drawer takes every tap until it is
   * closed. So on a phone the drawer is closed (by FabOrchestrator's own
   * shortcut again) as soon as the Settings window is up. */
  var closingDrawer = false;
  function closeDrawerOverSettings() {
    try {
      if (closingDrawer || !(phoneWidth && phoneWidth.matches)) return;
      if (!document.querySelector(SETTINGS)) return;
      if (!document.querySelector('[data-sidebar="sidebar"][data-mobile="true"][data-state="open"]')) return;
      closingDrawer = true;
      openSidebar(); // the shortcut toggles: open → closed
      setTimeout(function () {
        closingDrawer = false;
      }, 800);
    } catch (_error) {
      /* Never worth an error on FabOrchestrator's page. */
    }
  }

  /* FabOrchestrator moves between its pages without reloading, so the page is
   * looked at twice a second, and at once on Back/Forward and on rotation. */
  try {
    window.addEventListener("load", function () {
      try {
        addMobileStyle();
        setInterval(function () {
          placeNav();
          closeDrawerOverSettings();
        }, 500);
        // Promptly, too, when a menu item is chosen (the user menu's Settings).
        document.addEventListener("click", function (e) {
          if (e.target && e.target.closest && e.target.closest('[role="menuitem"]')) {
            setTimeout(closeDrawerOverSettings, 150);
          }
        });
        window.addEventListener("popstate", placeNav);
        if (phoneWidth && phoneWidth.addEventListener) phoneWidth.addEventListener("change", placeNav);
      } catch (_error) {
        /* Never worth an error on FabOrchestrator's page. */
      }
    });
  } catch (_error) {
    /* Never worth an error on FabOrchestrator's page. */
  }
})();
