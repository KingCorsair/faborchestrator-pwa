import type { NextConfig } from "next";
import { MAX_REQUEST_BODY_BYTES, REQUEST_BODY_CEILING_BYTES } from "./lib/gateway/body-limit";
import { PWA_ASSET_PREFIX, revalidateSourcePattern } from "./lib/gateway/registry";

// The ceiling must sit above the policy, or a body one byte over the policy
// arrives cut to exactly the policy and passes as whole (plan RP1 part 3).
if (REQUEST_BODY_CEILING_BYTES <= MAX_REQUEST_BODY_BYTES) {
  throw new Error("REQUEST_BODY_CEILING_BYTES must be larger than MAX_REQUEST_BODY_BYTES.");
}

/** The content security policy of the device-enrollment pages (see `headers()` below). */
const DEVICE_PAGE_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  experimental: {
    /**
     * How much of a request body Next hands this app (plan RP1 part 3, G2).
     *
     * Next reads every body that passes `proxy.ts` before any route runs, and
     * by default keeps only the first 10 MB. FabOrchestrator's chat sends the
     * whole conversation on every turn, so a long thread went past that and
     * reached FabOrchestrator cut short. 25 MiB is the policy (20 MiB, which
     * the gateway enforces with a coded 413) plus headroom, so an oversized
     * body is *seen* as oversized. See `lib/gateway/body-limit.ts`.
     */
    proxyClientMaxBodySize: REQUEST_BODY_CEILING_BYTES,
  },

  // Next 16's Turbopack infers its workspace root from the nearest lockfiles.
  // This tree sits under several ancestor lockfiles (see the root CLAUDE.md
  // entry for 2026-07-29), and without pinning the root it can pick a
  // directory with no `node_modules`, at which point `@import "tailwindcss"`
  // in app/globals.css cannot resolve.
  turbopack: { root: __dirname },

  /**
   * This app's own build output lives under a prefix, so bare `/_next/…` is
   * unambiguously FabOrchestrator's when the embedding gateway is on (WP1,
   * 2026-09-08). With `FO_EMBED_SURFACES` set, `proxy.ts` classifies bare
   * `/_next/*` as an FO asset and forwards it; this app's documents therefore
   * must not ask for their chunks there. `assetPrefix` makes them ask at
   * `/pwa-assets/_next/*` instead, and `proxy.ts` rewrites that back to the
   * real `/_next/*` before Next's filesystem routing — a same-origin path
   * prefix, not a CDN. With the flag unset the prefix still applies and the
   * rewrite still runs, so the app is byte-for-byte itself either way; the
   * rewrite is unconditional in `proxy.ts` for exactly that reason.
   *
   * Verified by build + local run (WP1): the app's own chunks resolve through
   * the prefix and the existing checks pass with the flag off. If a path-based
   * assetPrefix ever misbehaves under `output: "standalone"`, the fallback in
   * the architecture map is to drop this and have the middleware claim the
   * app's chunk paths from `.next/build-manifest.json` instead.
   */
  assetPrefix: PWA_ASSET_PREFIX,

  /**
   * Move Next's own dev-tools badge out of the bottom-left corner.
   *
   * ── Why this is here (2026-08-23) ──────────────────────────────────────────
   * The landing page's footer line — *Demo environment · mock MES data* — was
   * reported as clipped by "a dark circular avatar bottom-left". **Nothing in
   * this app draws that.** It is Next 16's development indicator, which
   * defaults to `bottom-left` (`devIndicators.position ?? 'bottom-left'` in
   * `next/dist/build/define-env.js`) and is injected client-side into a portal
   * above the page. The footer row is left-aligned, so the two land on top of
   * each other.
   *
   * **It does not exist in a production build**, so no product CSS was changed
   * to dodge it — padding or a z-index on the footer would have been a
   * permanent workaround for something the deployed app never renders, and the
   * next person would have had no way to tell why it was there.
   *
   * `bottom-right` rather than `false`: the badge reports build and hot-reload
   * status, which is worth keeping while working. Nothing renders in that
   * corner.
   */
  devIndicators: { position: "bottom-right" },

  // Emits `.next/standalone/server.js` with only the node_modules that are
  // actually reached — the container ships ~200 MB less than a full install,
  // and the deploy is correspondingly faster to push.
  //
  // It is also why the Dockerfile runs `node server.js` rather than
  // `npm start`: that script pins `--port 3002` for local use, while every
  // host assigns a port through `PORT`, which the standalone server reads.
  //
  // ⚠ **`npm run build` on Windows prints a wall of EINVAL and is fine.**
  // Turbopack names its externals chunks after the module they wrap, so they
  // arrive as `[externals]_node:path_….js` — and a colon is NTFS's
  // alternate-data-stream separator, illegal in a filename. The chunks build;
  // only the copy into `.next/standalone/` fails. Next treats it as a warning
  // and exits 0, so nothing downstream notices.
  //
  // Nothing local is affected: `npm start` serves `.next/`, not
  // `.next/standalone/`. And the deploy builds on Linux, where a colon in a
  // filename is ordinary — so the artefact that ships is the complete one.
  // The failure would only bite someone trying to run `.next/standalone/`
  // directly on Windows, which nothing here asks for.
  output: "standalone",
  // The device-credential feasibility test serves the QR decoder's wasm from
  // node_modules (`app/device-crypto-test/zxing_reader.wasm`).
  outputFileTracingIncludes: {
    "/device-crypto-test/zxing_reader.wasm": ["./node_modules/zxing-wasm/dist/reader/zxing_reader.wasm"],
  },

  /**
   * Documents must be revalidated; only the build output may be cached.
   *
   * ── The defect (2026-08-19) ────────────────────────────────────────────────
   * A statically prerendered page — `/orders`, `/activity`, `/decisions` — ships
   * `cache-control: s-maxage=31536000` and an ETag, with **no `max-age` and no
   * `no-cache`**. `s-maxage` binds shared caches only, so a browser is left to
   * apply heuristic freshness, and Safari does: it will reuse that HTML for a
   * long time without asking.
   *
   * That HTML names its JavaScript by content hash. **Every deploy replaces the
   * container, so the previous build's chunks stop existing** — verified, not
   * assumed: chunks confirmed live earlier the same day now return 404. A phone
   * holding a cached document therefore requests scripts that are gone, and the
   * page paints its server-rendered markup and then never hydrates. Nothing
   * errors visibly. It simply does not work, which is exactly how it was
   * reported.
   *
   * This was survivable while the app was deployed once. It became a real
   * failure mode after five deploys in a day.
   *
   * `no-cache` does not mean "do not store" — it means "revalidate before
   * reuse". With the ETag already present that is a 304 and a few bytes, so the
   * cost is one conditional request per navigation and the guarantee is that
   * the HTML on screen always names chunks the server still has.
   *
   * Everything under `/_next/static` is excluded because it is content-hashed
   * and genuinely immutable — that is the half of the caching story which was
   * always correct. `/_next/image` likewise. Unversioned assets in `public/`
   * (the icons, the zxing wasm, the demo labels) fall under the rule and are
   * better for it: they have no hash to bust, so revalidation is the only thing
   * that keeps them current, and a 304 costs nothing.
   *
   * ── `pwa-assets/` too, and it was missing (WP3, 2026-09-08) ───────────────
   * `assetPrefix` moved this app's own chunks to `/pwa-assets/_next/static/…`,
   * and this pattern excluded only the bare `_next/static`, so from WP1 until
   * this line **every content-hashed chunk this app owns was served
   * `no-cache, must-revalidate`** — revalidated on every navigation, on a
   * phone, for files whose names change whenever their contents do. Measured
   * against the preview and against production side by side: production, built
   * before the prefix, answered `public, max-age=31536000, immutable`; the
   * preview answered `no-cache`. FabOrchestrator's proxied chunks were correct
   * throughout, because the gateway passes their headers through and never
   * consults this rule.
   *
   * The exclusion is written to match the prefix optionally, so the rule keeps
   * behaving identically whether or not `assetPrefix` is set.
   */
  async headers() {
    return [
      {
        // Built from `IMMUTABLE_ASSET_PREFIXES`, so the exclusion cannot drift
        // from the prefix again — `__tests__/gateway/cache-policy.test.ts`
        // holds it against the paths both builds actually serve.
        source: revalidateSourcePattern(),
        headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }],
      },
      {
        // The device-enrollment pages (6 October 2026, `lib/devices/`). They are
        // this app's own, not FabOrchestrator's, so a policy here cannot break
        // an embedded FabOrchestrator page. No framing (a revoke button must not
        // be clickjacked), no referrer (the enrollment link carries a token),
        // no plugins, no foreign scripts or form targets. `'unsafe-inline'`
        // stays for scripts and styles because the root layout and Next's
        // hydration use inline scripts and this app has no nonce plumbing;
        // `'unsafe-eval'` is added in development only, for Next's dev runtime.
        source: "/:page(device-admin|device-blocked|device-enroll)/:rest*",
        headers: [
          { key: "Content-Security-Policy", value: DEVICE_PAGE_CSP },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        // The developer-only crypto feasibility test: the same policy, plus
        // 'wasm-unsafe-eval' for its QR decoder, which a production in-app
        // scanner would need too.
        source: "/device-crypto-test",
        headers: [
          { key: "Content-Security-Policy", value: DEVICE_PAGE_CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'") },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
