import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16's Turbopack infers its workspace root from the nearest lockfiles.
  // This tree sits under several ancestor lockfiles (see the root CLAUDE.md
  // entry for 2026-07-29), and without pinning the root it can pick a
  // directory with no `node_modules`, at which point `@import "tailwindcss"`
  // in app/globals.css cannot resolve.
  turbopack: { root: __dirname },

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
   */
  async headers() {
    return [
      {
        source: "/((?!_next/static|_next/image).*)",
        headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
