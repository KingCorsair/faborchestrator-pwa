/**
 * Which FabOrchestrator deployment answers a forwarded request.
 *
 * Normally one: `FABORCH_BASE_URL`, for everything. `FO_UI_BASE_URL`, when set,
 * takes over FabOrchestrator's **documents and static assets** only — its
 * pages, their RSC payloads and the `/_next` chunks they name — while every API
 * call still goes to `FABORCH_BASE_URL`.
 *
 * ── Why (11 September) ──────────────────────────────────────────────────────
 * The mobile-navigation fix is a change to FabOrchestrator's UI. Until their
 * team ships it, the preview needs to show it without touching FabOrchestrator
 * production, so the branch is built as its own app with no secrets and no
 * database (`fly.fo-ui-preview.toml`) and this sends it the page traffic. The
 * data behind those pages is still FabOrchestrator production's, exactly as
 * before. Unset — which is production's configuration — nothing changes.
 *
 * Pages and chunks must come from the same build: a document names its chunks
 * by content hash, so a page from one build and chunks from another is a blank
 * screen. That is why the split is by class, `fo-document` and `fo-static`
 * together, and never by individual path.
 *
 * ── Plain http, only on Fly's private network ───────────────────────────────
 * `foBaseUrl()` refuses http for anything but loopback because sign-in
 * passwords and session tokens travel on that connection. Nothing credentialed
 * travels on this one — documents and assets are forwarded anonymously (see
 * `app/fo-gateway/[...path]/route.ts`) — and a `.internal` host is reachable
 * only over Fly's WireGuard private network between this organisation's
 * machines. So http is accepted for exactly that suffix and for loopback, and
 * anything else must be https.
 */

import { FabOrchNotConfiguredError, foBaseUrl } from "@/lib/faborch/client";
import type { Owner } from "@/lib/gateway/registry";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const PRIVATE_NETWORK_SUFFIX = ".internal";

type Env = Readonly<Record<string, string | undefined>>;

/** The UI-only FabOrchestrator deployment, or null when there is none. */
export function foUiBaseUrl(env: Env = process.env): string | null {
  const value = env.FO_UI_BASE_URL?.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FabOrchNotConfiguredError(`FO_UI_BASE_URL is not a valid URL ("${value}").`);
  }

  const privateHost = url.hostname.endsWith(PRIVATE_NETWORK_SUFFIX) || LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && privateHost)) {
    return value.replace(/\/+$/, "");
  }
  throw new FabOrchNotConfiguredError(
    `FO_UI_BASE_URL must be https, or http on Fly's private network (*.internal) or loopback; ` +
      `got ${url.protocol}//${url.host}.`,
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
