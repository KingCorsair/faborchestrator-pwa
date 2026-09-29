/**
 * Putting a file on the operator's device (2026-09-29).
 *
 * ── An iPhone has nowhere to download to ─────────────────────────────────────
 * A desktop browser, and Android's, save an `<a download>` link to Downloads.
 * An iPhone app added to the home screen has no downloads folder to put it in;
 * what it has is the share sheet, whose "Save to Files" is where an iPhone
 * saves things. So on iOS a file goes to the share sheet when the browser can
 * share files, and everywhere else — or when sharing is refused — it downloads.
 *
 * Safari only opens the share sheet from a tap, and a tap stops counting as one
 * after the page has spent a few seconds fetching the file. When that happens
 * the share is refused with `NotAllowedError`, and the download link is the
 * fallback rather than an error.
 */

import { isIOSPlatform } from "@/lib/platform";

export type SaveOutcome = "shared" | "downloaded" | "cancelled";

export async function saveFile(blob: Blob, filename: string): Promise<SaveOutcome> {
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });

  const ios = isIOSPlatform(navigator.userAgent, navigator.maxTouchPoints);
  if (ios && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return "shared";
    } catch (error) {
      // The operator closed the sheet: that is a decision, not a failure.
      if ((error as Error)?.name === "AbortError") return "cancelled";
      // Anything else — most often the tap having expired — falls through.
    }
  }

  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Long enough for the browser to have started reading it; revoking at once
  // cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}
