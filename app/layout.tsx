import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { RegisterServiceWorker } from "@/components/register-sw";
import { IOSInstallHint } from "@/components/fab/ios-install-hint";
import "./globals.css";

/**
 * Plus Jakarta Sans — the V2 design system's typeface, used by the login page,
 * the cockpit and the chat shell. The product loads it from a Google Fonts
 * `@import`; this app self-hosts it through next/font instead, so it renders
 * the same on a factory network that cannot reach fonts.googleapis.com.
 */
const plusJakarta = Plus_Jakarta_Sans({
  variable: "--font-plus-jakarta",
  weight: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
  display: "swap",
});

/**
 * The app-wide title and description name **the platform**, not the production
 * order workflow — changed 2026-08-21, when `/` stopped being that workflow's
 * front door and became FabOrchestrator's. Pages that are about orders still
 * title themselves so (`/orders` is "Production orders — FabOrchestrator");
 * this is the fallback for the ones that are not.
 */
export const metadata: Metadata = {
  title: "FabOrchestrator",
  description:
    "An enterprise AI platform for manufacturing operations, with AI-assisted production order review.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // iOS reads this and nothing else. Without it, "Add to Home Screen" uses a
    // *screenshot of the page* as the icon — the most visible defect there is
    // in an iPhone demo, and invisible until somebody actually installs it.
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "FabOrchestrator",
    // `default`, not `black-translucent`. Translucent slides the page under the
    // status bar and makes iOS draw the clock and battery in **white** — over
    // this app's white header, that is an invisible status bar. `default` keeps
    // the bar opaque with dark text, which is what a light-surfaced app wants.
    statusBarStyle: "default",
  },
  robots: "noindex, nofollow",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // WCAG 1.4.4 / 1.4.10: never disable user zoom. A supervisor reading a defect
  // code through safety glasses needs pinch-to-zoom more than most.
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: "#10153a",
};

/**
 * Recovers a page whose JavaScript no longer exists on the server.
 *
 * Next names its chunks by content hash, and every deploy replaces the
 * container — so the previous build's chunks 404. A browser holding a cached
 * document then requests scripts that are gone: the server-rendered markup
 * paints, hydration never happens, and the app sits there looking loaded and
 * doing nothing. That is the state this app was reported to be in on a phone,
 * and nothing on the page can report it, because the page has no JavaScript.
 *
 * `next.config.ts` stops new documents from being cached that way. This is for
 * the ones already cached, which will not fetch that fix on their own.
 *
 * ── Why inline, and first in <body> ────────────────────────────────────────
 * Inline because a recovery script delivered as a chunk is subject to the exact
 * failure it recovers from. First in the body because Next's chunk tags are
 * `async` in `<head>`: their requests are in flight while the parser reaches
 * here, so the listener is registered before any of them can fail.
 *
 * ── Why `reload()` is enough ───────────────────────────────────────────────
 * A reload revalidates the document rather than reusing it, so the response
 * comes back with the current chunk names — and, from now on, with
 * `no-cache` attached so it cannot get stuck again.
 *
 * Once per tab session. If the reload lands on something equally broken the
 * page stays broken and visible, which is far better than a reload loop
 * nobody can escape.
 */
const CHUNK_RECOVERY = `
(function () {
  var KEY = "faborch-chunk-reload";
  addEventListener(
    "error",
    function (event) {
      var el = event.target;
      if (!el || el.tagName !== "SCRIPT") return;
      if (!el.src || el.src.indexOf("/_next/static/") === -1) return;
      try {
        if (sessionStorage.getItem(KEY)) return;
        sessionStorage.setItem(KEY, "1");
      } catch (e) {
        /* Private mode. One reload is still better than a dead page. */
      }
      location.reload();
    },
    true,
  );
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // `suppressHydrationWarning` on these two elements only, matching
    // claudeai_athena/app/layout.tsx. Browser extensions stamp attributes onto
    // <html> and <body> before React hydrates — Katalon Recorder adds
    // `katalonextensionid`, password managers and theme extensions do the same
    // — and React reports the resulting attribute mismatch as an error the
    // page author cannot fix. The flag is one level deep: it silences those two
    // elements' own attributes and nothing inside them, so a real mismatch in
    // the app's own markup still surfaces.
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className={`${plusJakarta.variable} h-full`} suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: CHUNK_RECOVERY }} />
        {children}
        <RegisterServiceWorker />
        {/* Renders nothing except on an iOS device that has not installed the
            app and has not already dismissed it. See the component header for
            why Safari needs this and Chrome does not. */}
        <IOSInstallHint />
      </body>
    </html>
  );
}
