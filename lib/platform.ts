/**
 * Platform detection, as a pure function so it can be tested.
 *
 * User-agent sniffing is normally the wrong tool and is used here for the one
 * thing feature detection cannot answer: **which install gesture to describe**.
 * There is no capability to probe. Safari never fires `beforeinstallprompt`, so
 * "can this browser install?" has no API — the only honest signal is that this
 * is an Apple device, where the answer is always Share → Add to Home Screen.
 *
 * Nothing about the app's behaviour depends on this. It selects the wording of
 * a hint; being wrong shows an irrelevant tip or none, never a broken screen.
 */

/**
 * Whether this is an iPhone, iPad or iPod.
 *
 * **iPadOS 13 and later deliberately lie.** An iPad reports itself as
 * `Macintosh` so that sites serve it the desktop layout, and there is no iPad
 * token anywhere in the string. The touch-point count is what still separates
 * it from a real Mac: a Mac reports 0 even with a trackpad, an iPad reports 5.
 * Without this branch every iPad — a very likely device for a shop-floor demo —
 * is treated as a desktop and never told how to install.
 *
 * Passed in rather than read from `navigator` so the awkward cases can be
 * asserted rather than assumed.
 */
export function isIOSPlatform(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return userAgent.includes("Macintosh") && maxTouchPoints > 1;
}
