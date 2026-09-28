/**
 * `POST /api/client-error` — a screen crashed in somebody's browser.
 *
 * ── Why this exists (2026-09-28) ────────────────────────────────────────────
 * A crash in the browser used to be visible only in that browser's console,
 * which on a phone nobody can open. The crash screen (`components/fab/
 * crash-screen.tsx`) now sends a short report here, and it lands in the same
 * log — and raises the same alert — as a server failure. The screen shows the
 * report's reference, so what the operator reads out and what support finds in
 * the log are the same string.
 *
 * ── Unauthenticated, so narrow ──────────────────────────────────────────────
 * A crash can happen before sign-in (the sign-in screen is a screen too), so
 * this cannot ask for a session. Everything else is therefore held tight:
 *
 *  - **size** — 4 KB, read with the same ceiling as every other route;
 *  - **shape** — `ClientErrorSchema`: a reference, a message, a path, Next's
 *    digest. A path only, never a query string, where `?q=` carries a question;
 *  - **rate** — ten recorded per address, forgotten ten minutes after the last
 *    one; beyond that, reports are accepted and not recorded, so a script
 *    cannot fill the log;
 *  - **the alert never carries the browser's words.** Anybody can post here, and
 *    a chat channel renders what it is sent. The alert says a screen crashed and
 *    gives the reference; the message itself stays in the log.
 *
 * Answers 202 whether or not the report was recorded: a crash screen has
 * nothing useful to do with the difference, and an attacker learns nothing.
 */

import { NextResponse, type NextRequest } from "next/server";
import { clientAddress } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { readJsonBody } from "@/lib/request-body";
import { createTtlCache } from "@/lib/ttl-cache";
import { CLIENT_ERROR_BODY_LIMIT, ClientErrorSchema } from "@/lib/validation";

export const runtime = "nodejs";

const REPORTS_PER_WINDOW = 10;
const WINDOW_MS = 10 * 60_000;

/** Reports recorded per address in the current window. */
const recent = createTtlCache<number>(WINDOW_MS, 10_000);

/** A crash in the browser, as the server records it. */
class ClientCrash extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientCrash";
    // Where this object was made — here, on the server — says nothing about the
    // crash, which happened in a browser. Only the message is worth keeping.
    this.stack = `ClientCrash: ${message}`;
  }
}

export async function POST(req: NextRequest) {
  const body = await readJsonBody(req, CLIENT_ERROR_BODY_LIMIT);
  if (body.tooLarge) return new NextResponse(null, { status: 413 });

  const parsed = ClientErrorSchema.safeParse(body.value);
  if (!parsed.success) return new NextResponse(null, { status: 400 });

  const address = clientAddress(req.headers);
  const count = recent.get(address) ?? 0;
  if (count >= REPORTS_PER_WINDOW) return new NextResponse(null, { status: 202 });
  recent.set(address, count + 1);

  const { reference, message, digest, path } = parsed.data;
  reportError(
    "client",
    new ClientCrash(message),
    { reference, digest: digest ?? null, path },
    { alert: `A screen crashed in a browser, on ${path} (reference ${reference})` },
  );

  return new NextResponse(null, { status: 202 });
}
