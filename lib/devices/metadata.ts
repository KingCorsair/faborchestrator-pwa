/**
 * Descriptive metadata for an enrolled device: what an administrator sees in
 * the device list. **Never an access decision.** The user agent is whatever the
 * browser chooses to say and anybody can change it; the device token is the
 * credential (`lib/devices/credential.ts`). These are coarse labels for a
 * person reading a table, nothing more.
 */

import type { DeviceMetadata } from "./store";

export function describeDevice(userAgent: string | null, installedApp: boolean): DeviceMetadata {
  const ua = userAgent ?? "";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "Unknown";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /CriOS|Chrome\//.test(ua)
      ? "Chrome"
      : /FxiOS|Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua) || /AppleWebKit/.test(ua)
          ? "Safari"
          : "Unknown";
  const deviceType = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
    ? "tablet"
    : /Mobile|iPhone|iPod|Android/.test(ua)
      ? "phone"
      : ua
        ? "desktop"
        : "unknown";
  const context = installedApp ? "installed-app" : "browser";
  return {
    friendlyName: `${os} ${browser}${installedApp ? " (app)" : ""}`,
    deviceType,
    os,
    browser,
    context,
  };
}
