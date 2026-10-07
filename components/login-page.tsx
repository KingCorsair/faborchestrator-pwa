"use client";

/**
 * Sign-in.
 *
 * Drawn in the V2 language the product's own login page uses — the navy brand
 * panel, the white card at radius 22 with its soft shadow, the filled fields at
 * radius 12, the gradient primary button. Not a copy of that page: it carries
 * SSO buttons, marketing propositions and a password-reset flow this demo has
 * none of, and shipping dead controls in a demo is worse than shipping fewer.
 *
 * The session it writes is the convention `useSession` reads — the same two
 * localStorage keys FabOrchestrator uses.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { BrandLockup } from "@/components/fab/brand";
import { Button, Label } from "@/components/fab/primitives";
import { submittedCredentials } from "@/lib/credentials";
import { endClientSession } from "@/lib/end-client-session";
import { DEFAULT_RETURN_PATH } from "@/lib/return-path";
import { AUTH_TOKEN_KEY, readStored, storeSession, type StoredUser } from "@/lib/stored-session";
import { signInProof, storedDevice } from "@/lib/devices/keystore";

export interface LoginPageProps {
  /**
   * Where to go once signed in. Validated by the route before it reaches here —
   * this component never sees a value it should not navigate to, which is why
   * it does no checking of its own.
   */
  next?: string;
  /**
   * Whether this deployment requires an approved device (`DEVICE_GATE`,
   * `lib/devices/gate.ts`). Then the page checks this device's key before it
   * shows the form, and sends a device without one to `/device-blocked`.
   */
  deviceRequired?: boolean;
}

export function LoginPage({ next = DEFAULT_RETURN_PATH, deviceRequired = false }: LoginPageProps) {
  const router = useRouter();
  /*
    The credential fields are deliberately **uncontrolled**.

    As controlled inputs they were bound to state that does not exist until
    React hydrates. The page is server-rendered, so it paints and accepts typing
    before that — and on hydration React reconciles each field to its state,
    which is empty, and erases what was typed. The operator watches their own
    email vanish out of the box with no error and nothing to react to.

    Adopting the value in an effect does not fix it: effects run after React has
    already committed the reset, so there is nothing left to read.

    Uncontrolled, React never touches the value. Early typing is simply kept by
    the DOM, and `FormData` at submit reads exactly what the operator sees. The
    fields are read at one moment — submission — and nothing else here needs
    their value between keystrokes.

    Measured on the deployment, where the hydration window is wide enough to hit
    by hand. On localhost it is too narrow to notice, which is why every local
    check passed while this was broken.
  */
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  /**
   * The approved device, before the person (device enrollment, 6 October
   * 2026). The device's key lives in this browser's IndexedDB
   * (`lib/devices/keystore.ts`); without one there is nothing to sign in with,
   * so the form is never shown and the device goes to the device-check page.
   * `null` while unknown; with the gate off nothing is required and the form
   * shows at once.
   */
  const [device, setDevice] = React.useState<string | null | "checking">(deviceRequired ? "checking" : null);
  React.useEffect(() => {
    let cancelled = false;
    void storedDevice().then((stored) => {
      if (cancelled) return;
      if (stored.kind === "enrolled") setDevice(stored.credential.deviceId);
      else if (deviceRequired) window.location.replace("/device-blocked");
      else setDevice(null);
    });
    return () => {
      cancelled = true;
    };
  }, [deviceRequired]);

  /**
   * Whether a session already exists on this device, once checked.
   * `null` while unknown — the notice must not flash before we know.
   */
  const [existing, setExisting] = React.useState<{ email: string; faborch: boolean } | null>(null);

  /**
   * A visitor who already holds a session is **told**, never bounced.
   *
   * ── The defect this replaces ────────────────────────────────────────────────
   * This used to be `if (localStorage.getItem(AUTH_TOKEN_KEY)) router.replace(next)`
   * — a silent redirect away from the form the moment any token was present.
   * Three ways that trapped somebody, all of them reported as "sign-in does not
   * work":
   *
   *  1. `AUTH_TOKEN_KEY` is `llmatscale_auth_token`, the key FabOrchestrator
   *     itself uses and the one every earlier build of this app used. On a
   *     shared origin — `localhost:3002` across rebuilds, or a deployment that
   *     replaced an older one — a leftover token from a different app bounced
   *     the visitor off a form they had every right to use.
   *  2. A **demo-credential** session was a real session here, so the guard
   *     fired, but it carried no FabOrchestrator access. The visitor was
   *     returned to the app, opened an agent, and found the composer disabled
   *     with no way back to sign-in. That credential has since been removed
   *     entirely (WP2) - but the trap was this redirect, not only the
   *     credential: a stale token from any earlier build does the same thing.
   *  3. An expired token still satisfies `getItem`, so the redirect fired, the
   *     destination bounced them back here, and the form vanished again.
   *
   * The guard's intent was sound — do not show a sign-in form to somebody who
   * does not need one — but a silent redirect is the wrong shape for it: it is
   * invisible, it cannot be argued with, and it fails closed on the one person
   * who needs the form most. Now the form always works, and an existing session
   * is surfaced as a notice offering to continue.
   */
  React.useEffect(() => {
    // Storage that throws (site data blocked, some private modes) holds no
    // session to surface; the form below still works and says why if a
    // sign-in cannot be kept. Guard ported from the chetan branch (e843b9c).
    const token = readStored(AUTH_TOKEN_KEY);
    if (!token) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/pwa/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (cancelled) return;
        if (res.status === 401) {
          // Stale or expired — including a token left by a different app on
          // this origin. End it rather than reasoning about it, so the form
          // below is the clean sign-in it looks like. Ending, not only
          // clearing: the cookie beside it holds a FabOrchestrator session
          // that would otherwise stay alive (plan RP2, m3). No navigation;
          // this is already the sign-in page.
          //
          // Unless a sign-in has already replaced it: a quick (autofilled)
          // sign-in can finish before this answer arrives, and ending "the
          // session" now would end the new one.
          if (readStored(AUTH_TOKEN_KEY) !== token) return;
          endClientSession("pwa_expired", { navigate: false });
          return;
        }
        // Anything else (the server unwell) says nothing about the session:
        // show no notice, and keep what is stored.
        if (!res.ok) return;
        const data = (await res.json()) as {
          user?: { email?: string };
          faborch?: boolean;
        };
        setExisting({
          email: data.user?.email ?? "this device",
          faborch: data.faborch === true,
        });
      } catch {
        // Offline, or the server is down. Say nothing rather than claim a
        // session state we could not check; the form still works.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const formRef = React.useRef<HTMLFormElement>(null);

  /**
   * Has React attached yet — and keep whatever was typed before it did.
   *
   * An effect cannot run during server rendering or before hydration, so this
   * flips exactly when the form becomes able to handle its own submission.
   *
   * The adoption is the important half. These are controlled inputs, so on
   * hydration React reconciles each field to its state — which is empty — and
   * **erases anything typed into the server-rendered HTML before it attached.**
   * The operator watches their own email disappear out of the box, with no
   * error and nothing to react to. Reading the DOM here and seeding state from
   * it keeps those keystrokes, so early typing is merely early rather than
   * lost.
   *
   * Measured on the deployment: the window is wide enough to hit by hand, and
   * on localhost it is too narrow to notice — which is why every local check
   * passed while this was broken.
   */
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    /**
     * Read what is actually in the fields, not what React thinks is.
     *
     * Typing that lands before React hydrates never reaches state, so the form
     * used to submit an empty email while the field visibly held one. See
     * `lib/credentials.ts` for the full account — found on the Fly deployment,
     * invisible on localhost.
     */
    // `currentTarget` is captured before any `await`: React clears it once the
    // handler yields. The rule itself lives in `lib/credentials.ts`, where it
    // can be tested without rendering React.
    const { email: submittedEmail, password: submittedPassword } = submittedCredentials(
      new FormData(event.currentTarget),
    );

    setBusy(true);
    setError(null);

    try {
      // The device proves itself first: a fresh challenge, signed with the key
      // it made at enrollment. Sent whenever this device has a key (so sessions
      // are bound to their device even before the gate is turned on); required
      // when the gate is on, and the server checks it before the password.
      let deviceProof: { deviceId: string; challengeId: string; signature: string } | undefined;
      if (device && device !== "checking") {
        const proof = await signInProof();
        if (proof.ok) deviceProof = proof.proof;
        else if (deviceRequired) {
          if (proof.reason === "unavailable") {
            setError(proof.detail ?? "This device could not be checked just now. Try again shortly.");
          } else {
            window.location.replace("/device-blocked");
          }
          return;
        }
      }

      const res = await fetch("/api/pwa/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: submittedEmail, password: submittedPassword, ...(deviceProof ? { device: deviceProof } : {}) }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.code === "device_revoked" || data.code === "device_not_approved") {
          window.location.replace(`/device-blocked${data.code === "device_revoked" ? "?reason=revoked" : ""}`);
          return;
        }
        setError(data.error ?? "Sign-in failed");
        return;
      }

      // Signed in at FabOrchestrator, but the session has to be kept on this
      // device too: the bearer beside the cookie is what every request needs,
      // and FabOrchestrator's own pages read the user from the blob beside it
      // (plan RP2, G30). If storage refuses it, end the session the server
      // just started rather than leave half of one behind, and say what is
      // actually wrong instead of "could not reach the server".
      if (!storeSession(data.token, data.expiresAt, data.user as StoredUser | undefined)) {
        endClientSession("storage_unavailable", { navigate: false });
        setError(
          "This browser is blocking the storage sign-in needs. Allow this site to store data " +
            "(or leave private browsing) and try again.",
        );
        return;
      }
      // `next` from the server wins: FabOrchestrator's change page when the
      // account must change its password (plan RP2, G20). Anything else goes
      // where the operator was headed.
      router.replace(data.next === "/force-password-change" ? data.next : next);
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fab grid min-h-full lg:grid-cols-[1fr_1.1fr]">
      {/* Brand panel — hidden on a handheld, where it would push the form
          below the fold for no benefit. */}
      <aside
        className="hidden flex-col justify-between p-12 lg:flex"
        style={{
          background: "linear-gradient(160deg,var(--navy-1) 0%,var(--navy-2) 45%,var(--navy-3) 100%)",
        }}
      >
        <BrandLockup size="panel" tone="on-navy" />

        <div className="flex max-w-[420px] flex-col gap-4">
          {/*
            Rewritten 2026-09-30. It described a production order workflow on
            mock data, which the embedded app no longer has: behind this door is
            FabOrchestrator itself, its agents, chats and dashboards.
          */}
          <h2 className="text-[30px] leading-[1.15] text-white">
            Ask your agents. Decide on the floor.
          </h2>
          <p className="m-0 text-[16px]" style={{ color: "var(--on-navy-body)" }}>
            FabOrchestrator on your phone: put a question to its agents, open a dashboard, or
            carry on a conversation you started at your desk.
          </p>
        </div>

        {/* Everything behind this door is the running FabOrchestrator. */}
        <p className="m-0 text-[12px]" style={{ color: "var(--on-navy-label)" }}>
          Live FabOrchestrator · your own account
        </p>
      </aside>

      {/* Form */}
      <main className="flex items-center justify-center p-6">
        <form
          ref={formRef}
          onSubmit={onSubmit}
          /*
            `method="post"` is a safety net, not a route.
            
            The fields carry `name` attributes so the handler can read them with
            FormData (see `lib/credentials.ts`), and a named field makes the form
            natively submittable. If a submit ever escapes React — a click landing
            in the gap before hydration, or a scripting error — the browser
            performs that submission itself, and a form defaults to GET. That put
            the **password in the query string**, where it reaches browser
            history, server logs and referrer headers.
            
            POST keeps a stray submission in a body instead. Nothing serves this
            route, so it fails; it fails without writing the credential anywhere.
            The real prevention is `hydrated` on the button below.
          */
          method="post"
          className="fab-card flex w-full max-w-[440px] flex-col gap-[18px]"
          style={{ padding: "40px 38px", boxShadow: "0 24px 60px rgba(16,21,58,.16)" }}
        >
          <span
            className="inline-flex w-fit items-center gap-2 px-[13px] py-[7px] text-[12px] font-extrabold tracking-[0.05em]"
            style={{
              borderRadius: 20,
              color: "var(--cockpit-indigo)",
              background: "var(--brand-indigo-bg)",
            }}
          >
            SHOP FLOOR ACCESS
          </span>

          {/* "PWA", because this is not the FabOrchestrator website and the
              screen never said so. Same account, different front door — and a
              visitor who does not know which one they have opened cannot tell
              from anything else here. */}
          <h1 className="text-[26px]">Sign in to FabOrchestrator PWA</h1>
          {device && device !== "checking" ? (
            <p data-testid="approved-device" className="m-0 -mt-[8px] text-[12px]" style={{ color: "var(--text-muted-cool)" }}>
              Approved device: <strong>{device}</strong>
            </p>
          ) : null}

          {/*
            An existing session, surfaced rather than acted on. The two states
            differ in what the visitor most likely came here to do:

            - no FabOrchestrator session: they are almost certainly here to add
              one, because that is the only thing this form gives them that they
              do not already have. Lead with that.
            - a full session: they may have arrived by habit or by a stale
              bookmark. Offer to continue, but never take the decision for them.

            Either way the form below stays usable, which is the whole point of
            the change: signing in as somebody else must always be possible.
          */}
          {existing ? (
            <div
              className="flex flex-col gap-[10px] px-[15px] py-[13px] text-[13px]"
              style={{
                borderRadius: 12,
                background: existing.faborch ? "var(--brand-indigo-bg)" : "var(--cockpit-warn-bg, #FFF6E5)",
                color: "var(--text-ink)",
              }}
            >
              <span>
                {existing.faborch ? (
                  <>
                    You are already signed in as <strong>{existing.email}</strong>, with
                    FabOrchestrator access.
                  </>
                ) : (
                  <>
                    You are signed in as <strong>{existing.email}</strong>, but this session has
                    no FabOrchestrator access — agents will not accept a question. Sign in
                    below with your FabOrchestrator account to add it.
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={() => router.replace(next)}
                className="w-fit cursor-pointer border-0 bg-transparent p-0 text-[13px] font-bold underline"
                style={{ color: "var(--cockpit-indigo)" }}
              >
                Continue without signing in again
              </button>
            </div>
          ) : null}

          {/*
            Says which credential to use, on the screen where it is typed.

            There is only one (WP2, 2026-09-01): a FabOrchestrator account. The
            line stays because the field does not say whose password it wants,
            and because the demo credential that used to be accepted here is
            gone; this sentence is what stops somebody looking for it.
          */}
          <p
            className="m-0 -mt-[6px] max-w-[var(--measure)] text-[12px] font-normal leading-[1.6]"
            style={{ color: "var(--text-muted-cool)" }}
          >
            Use your FabOrchestrator account. You get FabOrchestrator itself: the same
            agents, chats and dashboards, answering with your tools, your role and your
            data.
          </p>

          <label className="flex flex-col gap-[7px]">
            <Label>Email</Label>
            <div
              className="flex items-center gap-[11px] px-[15px] py-[13px]"
              style={{ background: "var(--field-bg)", borderRadius: "var(--r-control)" }}
            >
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                className="w-full min-w-0 bg-transparent text-[16px] font-medium outline-none"
                style={{ border: 0, color: "var(--text-ink)" }}
              />
            </div>
          </label>

          <label className="flex flex-col gap-[7px]">
            <Label>Password</Label>
            <div
              className="flex items-center gap-[11px] px-[15px] py-[13px]"
              style={{ background: "var(--field-bg)", borderRadius: "var(--r-control)" }}
            >
              <input
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                className="w-full min-w-0 bg-transparent text-[16px] font-medium outline-none"
                style={{ border: 0, color: "var(--text-ink)" }}
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="flex-none cursor-pointer border-0 bg-transparent p-0"
                style={{ color: "var(--text-subtle)" }}
              >
                {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
              </button>
            </div>
          </label>

          {error ? (
            <p
              role="alert"
              className="m-0 px-4 py-[10px] text-[14px]"
              style={{
                borderRadius: "var(--r-control)",
                background: "var(--status-red-bg)",
                border: "1px solid var(--status-red-border)",
                color: "var(--status-red)",
              }}
            >
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            /*
              Disabled until React has attached. The form is server-rendered, so
              it paints and becomes clickable before `onSubmit` exists — and a
              click in that gap is handled by the browser, not by this component.
              The window is invisible on localhost and real on a phone.
            */
            disabled={busy || !hydrated || device === "checking"}
            className="mt-1 w-full justify-center py-[15px] text-[16px]"
            style={{ borderRadius: 13 }}
          >
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </main>
    </div>
  );
}
