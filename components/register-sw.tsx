"use client";

/**
 * Registers `public/sw.js`.
 *
 * Registration is deferred to an effect and failures are swallowed: a browser
 * with service workers disabled, or a page served over plain HTTP on a test rig,
 * should still be a working app — it simply is not an installable one.
 */

import * as React from "react";

export function RegisterServiceWorker() {
  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* Not installable here. Nothing else depends on it. */
    });
  }, []);

  return null;
}
