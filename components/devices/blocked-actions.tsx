"use client";

/**
 * The blocked page's two actions.
 *
 * 1. **End whatever session this browser still holds**, once, on arrival. A
 *    device that has just been revoked may still have a signed-in session;
 *    `endClientSession` asks the server to clear the FabOrchestrator cookie and
 *    revoke its token, and forgets the local copy. On a browser that never had
 *    a session it changes nothing.
 * 2. **Open an enrollment link by pasting it.** On an iPhone the camera opens a
 *    scanned link in Safari, and Safari and the installed Home Screen app keep
 *    separate cookies: a device enrolled in Safari is not enrolled in the app.
 *    Pasting the link here, inside the installed app, enrolls the app itself.
 *    Only a link to this app's own `/device-enroll/<code>` is accepted.
 */

import * as React from "react";
import { Button, Label } from "@/components/fab/primitives";
import { endClientSession } from "@/lib/end-client-session";
import { fieldInput, fieldShell, Notice } from "./device-card";

const ENROLL_PATH = /^\/device-enroll\/[A-Za-z0-9_-]{43}$/;

/** The same-origin enrollment path in what was pasted, or null. */
export function enrollmentPathFrom(pasted: string, origin: string): string | null {
  try {
    const url = new URL(pasted.trim(), origin);
    if (url.origin !== origin || !ENROLL_PATH.test(url.pathname)) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

export function BlockedActions() {
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    endClientSession("device_blocked", { navigate: false });
  }, []);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("link") ?? "");
    const path = enrollmentPathFrom(value, window.location.origin);
    if (!path) {
      setError("That is not an enrollment link for this app.");
      return;
    }
    window.location.replace(path);
  }

  return (
    <form onSubmit={onSubmit} method="post" className="flex flex-col gap-[10px]">
      <label className="flex flex-col gap-[7px]">
        <Label>Have an enrollment link? Paste it here</Label>
        <div className="flex items-center gap-[11px] px-[15px] py-[13px]" style={fieldShell}>
          <input
            name="link"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="w-full min-w-0 bg-transparent text-[15px] outline-none"
            style={fieldInput}
          />
        </div>
      </label>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button type="submit" variant="secondary" className="w-full justify-center py-[13px]">
        Open enrollment link
      </Button>
    </form>
  );
}
