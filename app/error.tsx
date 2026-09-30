"use client";

/**
 * One of this app's own screens failed while rendering. The root layout is
 * intact, so the fonts, the theme and the service worker's registration are
 * still here. See `components/fab/crash-screen.tsx` (ported from the `chetan`
 * branch, adapted to the plan's RP5).
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
