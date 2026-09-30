/**
 * Which FabOrchestrator deployment answers a forwarded request.
 *
 * **One: `FABORCH_BASE_URL`, for everything** — FabOrchestrator's pages, its
 * `/_next` assets and its API all come from the real FabOrchestrator. That is
 * the product this app delivers, and since 2026-09-30 it is the only thing a
 * deployment gets unless it opts out deliberately.
 *
 * ── The preview split, and why it now needs a second switch (RP1, G18) ──────
 * `FO_UI_BASE_URL` sends FabOrchestrator's **documents and static assets** to a
 * separate UI build while every API call still goes to `FABORCH_BASE_URL`. It
 * exists to preview an unshipped FabOrchestrator UI change — on 11 September,
 * the mobile-navigation fix, built as its own app with no secrets and no
 * database (`fly.fo-ui-preview.toml`). Nothing stopped it being set in
 * production by mistake, where the app would silently serve screens that are
 * not FabOrchestrator's. So it is honoured only beside `FO_UI_SPLIT_ALLOWED=1`;
 * set without that flag, every FabOrchestrator page fails closed with a
 * `not_configured` refusal rather than quietly using the other build.
 *
 * Pages and chunks must come from the same build: a document names its chunks
 * by content hash, so a page from one build and chunks from another is a blank
 * screen. That is why the split is by class, `fo-document` and `fo-static`
 * together, and never by individual path.
 *
 * ── Plain http, only on Fly's private network ───────────────────────────────
 * `foBaseUrl()` refuses http for anything but loopback because sign-in
 * passwords and session tokens travel on that connection. Nothing credentialed
 * travels on this one — documents and assets are forwarded anonymously — and a
 * `.internal` host is reachable only over Fly's private network between this
 * organisation's machines. So http is accepted for exactly that suffix and for
 * loopback, and anything else must be https.
 */

import { FabOrchNotConfiguredError, foBaseUrl } from "@/lib/faborch/client";
import type { Owner } from "@/lib/gateway/registry";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const PRIVATE_NETWORK_SUFFIX = ".internal";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The UI-only FabOrchestrator deployment, or null when there is none. Throws
 * `FabOrchNotConfiguredError` when one is named without the preview flag, or
 * named badly.
 */
export function foUiBaseUrl(env: Env = process.env): string | null {
  const value = env.FO_UI_BASE_URL?.trim();
  if (!value) return null;

  if (env.FO_UI_SPLIT_ALLOWED?.trim() !== "1") {
    throw new FabOrchNotConfiguredError(
      "FO_UI_BASE_URL is set without FO_UI_SPLIT_ALLOWED=1. FabOrchestrator's screens come from " +
        "FABORCH_BASE_URL; a separate UI build is a preview device and must be switched on deliberately.",
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FabOrchNotConfiguredError("FO_UI_BASE_URL is not a valid URL.");
  }

  const privateHost = url.hostname.endsWith(PRIVATE_NETWORK_SUFFIX) || LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && privateHost)) {
    return value.replace(/\/+$/, "");
  }
  throw new FabOrchNotConfiguredError(
    "FO_UI_BASE_URL must be https, or http on Fly's private network (*.internal) or loopback.",
  );
}

/** The origin a request of this class is forwarded to. */
export function upstreamOrigin(owner: Owner, env: Env = process.env): string {
  if (owner === "fo-document" || owner === "fo-static") {
    const ui = foUiBaseUrl(env);
    if (ui) return ui;
  }
  return foBaseUrl();
}

/**
 * Every FabOrchestrator origin a `Location` may name (RP1, G17): with the
 * preview split on, a redirect from either build must land on this app, not
 * carry the phone off to the other origin.
 */
export function foOrigins(env: Env = process.env): string[] {
  const ui = foUiBaseUrl(env);
  const api = foBaseUrl();
  return ui && ui !== api ? [api, ui] : [api];
}
