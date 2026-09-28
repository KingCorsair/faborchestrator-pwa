"use client";

/**
 * A screen failed while rendering. The root layout is intact, so the fonts,
 * the theme and the service worker's registration are still here.
 *
 * Without this file, Next showed its own "Application error" page instead — see
 * `components/fab/crash-screen.tsx` for what that cost on an installed app.
 */

import { CrashScreen } from "@/components/fab/crash-screen";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <CrashScreen error={error} reset={reset} />;
}
