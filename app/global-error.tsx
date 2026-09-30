"use client";

/**
 * The root layout itself failed, so nothing above this exists: it has to bring
 * its own `<html>` and `<body>`, and its own stylesheet. The font does not come
 * with it (`next/font` is loaded by the layout that failed), so the screen falls
 * back to the system face.
 *
 * See `components/fab/crash-screen.tsx`.
 */

import "./globals.css";
import { CrashScreen } from "@/components/fab/crash-screen";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">
        <CrashScreen error={error} reset={reset} />
      </body>
    </html>
  );
}
