/**
 * A password change FabOrchestrator may not have finished (plan RP2, G20).
 *
 * FabOrchestrator holds a user whose password must be changed at
 * `/force-password-change`. Its change-password route updates the hash but, in
 * the clone, **does not clear the `forcePasswordChange` flag** (§9 question 44),
 * so the user would be sent round the same page on every sign-in with no way
 * out. The PWA cannot clear the flag; it can only say what is wrong. So the
 * gateway marks the browser when a change succeeds, and a later sign-in **by
 * the same user** that FabOrchestrator still holds for a change is refused with
 * that explanation instead of the loop. Once FabOrchestrator clears the flag,
 * that user's next sign-in is ordinary and the mark is dropped.
 *
 * ── Bound to the user, not the handset ──────────────────────────────────────
 * A shared floor handset serves several people. The mark's value is an HMAC of
 * the FabOrchestrator user id under this app's signing key, so it answers only
 * for the user who changed a password here: somebody else held for a change
 * on the same handset still reaches FabOrchestrator's change page, and nobody
 * can mint a mark for another user without the key. It survives sign-out on
 * purpose, because signing out and back in is exactly how the loop shows
 * itself; it lasts a day. It holds nothing secret.
 */

import { createHmac } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { sessionKeyRing } from "@/lib/auth";

export const PASSWORD_CHANGED_COOKIE = "faborch_pw_changed";

/** The mark's value for one user: an HMAC of the id under the current signing key. */
export function passwordMarkFor(userId: string): string {
  return createHmac("sha256", sessionKeyRing().current.secret)
    .update(`pw-changed:${userId}`)
    .digest("base64url")
    .slice(0, 22);
}

/** Remember on this browser that `userId` changed their password here. */
export function markPasswordChanged(res: NextResponse, userId: string, secure: boolean): void {
  res.cookies.set({
    name: PASSWORD_CHANGED_COOKIE,
    value: passwordMarkFor(userId),
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 24 * 60 * 60,
  });
}

/** Whether this browser holds a mark for exactly this user. */
export function passwordChangeMarkedFor(req: NextRequest, userId: string): boolean {
  const value = req.cookies.get(PASSWORD_CHANGED_COOKIE)?.value;
  return !!value && value === passwordMarkFor(userId);
}

export function clearPasswordChangeMark(res: NextResponse): void {
  res.cookies.set({ name: PASSWORD_CHANGED_COOKIE, value: "", path: "/", maxAge: 0 });
}
