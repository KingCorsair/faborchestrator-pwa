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
import { ArrowRight, Eye, EyeOff, Lock, Mail } from "lucide-react";
import { BrandLockup } from "@/components/fab/brand";
import { Button } from "@/components/fab/primitives";
import { submittedCredentials } from "@/lib/credentials";
import { DEFAULT_RETURN_PATH } from "@/lib/return-path";

const AUTH_TOKEN_KEY = "llmatscale_auth_token";
const AUTH_SESSION_KEY = "llmatscale_auth_session";

export interface LoginPageProps {
  /**
   * Where to go once signed in. Validated by the route before it reaches here —
   * this component never sees a value it should not navigate to, which is why
   * it does no checking of its own.
   */
  next?: string;
}

export function LoginPage({ next = DEFAULT_RETURN_PATH }: LoginPageProps) {
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
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!token) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          // Stale or expired — including a token left by a different app on
          // this origin. Clear it rather than reasoning about it, so the form
          // below is the clean sign-in it looks like.
          localStorage.removeItem(AUTH_TOKEN_KEY);
          localStorage.removeItem(AUTH_SESSION_KEY);
          return;
        }
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
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: submittedEmail, password: submittedPassword }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error ?? "Sign-in failed");
        return;
      }

      localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ expiresAt: data.expiresAt }));
      router.replace(next);
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    // `min-[881px]`, which is FabOrchestrator's own breakpoint for this split
    // (`components/login-page.tsx`, `min-[881px]:grid-cols-…`). It was `lg`
    // (1024px), so the two products changed shape at different widths on the
    // same tablet.
    <div className="fab grid min-h-full min-[881px]:grid-cols-[1fr_1.1fr]">
      {/* Brand panel — hidden on a handheld, where it would push the form
          below the fold for no benefit. */}
      <aside
        className="hidden flex-col justify-between p-12 min-[881px]:flex"
        style={{
          background: "linear-gradient(160deg,var(--navy-1) 0%,var(--navy-2) 45%,var(--navy-3) 100%)",
        }}
      >
        <BrandLockup size="panel" tone="on-navy" />

        <div className="flex max-w-[420px] flex-col gap-4">
          {/*
            Widened on 2026-08-24, for the same reason as the sign-in copy
            opposite: this screen described the production order workflow alone,
            so it read as a production-order demo and people signed in with the
            credential that opens only that. The PWA is FabOrchestrator's
            cockpit — four agents and the order workflow — and the door should
            say so.
          */}
          <h2 className="text-[30px] leading-[1.15] text-white">
            Ask your agents. Decide on the floor.
          </h2>
          <p className="m-0 text-[16px]" style={{ color: "var(--on-navy-body)" }}>
            Put a question to FabOrchestrator, or find a production order, see what the
            MES actually recorded against it, and decide what happens next.
          </p>
        </div>

        {/*
          Was "Demo environment · mock MES data", which stopped being true when
          the agents started answering from the running FabOrchestrator. The
          order workflow is mock; the agents are not, and a visitor is entitled
          to know which half of the screen is real before they read an answer
          off it.
        */}
        <p className="m-0 text-[12px]" style={{ color: "var(--on-navy-label)" }}>
          Demo environment · mock order data · live FabOrchestrator agents
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
          {/* The product's own badge, lock and all. It read SHOP FLOOR ACCESS,
              which was this app's phrase rather than the platform's. */}
          <span
            className="inline-flex w-fit items-center gap-2 px-[13px] py-[7px] text-[11px] font-bold tracking-[0.05em]"
            style={{
              borderRadius: 20,
              color: "var(--cockpit-indigo)",
              background: "var(--brand-indigo-bg)",
            }}
          >
            <Lock size={13} strokeWidth={2.2} aria-hidden="true" />
            SECURE SIGN-IN
          </span>

          {/*
            FabOrchestrator sets this at a flat 31px. Stepped here, because its
            card sits on a desktop and this one has to survive 360px: at 31px
            "Sign in to FabOrchestrator" takes three lines inside a content box
            284px wide, and the fields drop below the fold before anything has
            been typed.

            The wording stays this app's. FO says "Sign in to continue", which is
            right once you are already inside FabOrchestrator; here the name is
            the one thing on screen that says *whose* account the field wants.
          */}
          <h1 className="text-[27px] font-extrabold tracking-[-0.6px] sm:text-[31px]">
            Sign in to FabOrchestrator
          </h1>

          {/*
            One lead line, at FO's size, because FO has one.

            This first shipped as *two* paragraphs — FO's "Welcome back…" on top
            of the existing note about which account to use — and the screenshot
            settled it: six lines of copy before the first field pushed the card
            past the fold at 390x844 and put the footer under the install hint.
            FO's card leads with a single sentence, and matching its hierarchy
            matters more than carrying both sentences.

            What survives from the old note is the part that does work: *whose*
            account this wants. The tail it used to carry — that the agents
            answer with your tools, your role and your data — is the brand
            panel's copy, and repeating it inside the card was always
            duplication.
          */}
          <p
            className="m-0 -mt-[8px] text-[15px] leading-[1.5]"
            style={{ color: "var(--text-muted-cool)" }}
          >
            Welcome back. Sign in with your FabOrchestrator account.
          </p>

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
            The paragraph that stood here — "Use your FabOrchestrator account.
            It opens the agents and the production order workflow…" — moved up
            into the lead line on 6 September, shortened.

            Its job was to say which credential to use, on the screen where it
            is typed: there is only one (WP2, 2026-09-01), the app is not
            FabOrchestrator, the field does not say whose password it wants, and
            the demo credential that used to be accepted produced a session that
            met a second sign-in the moment an agent was opened. That job is
            still done, by "Sign in with your FabOrchestrator account" above.
            What was dropped is the tail about tools, role and data, which is
            the brand panel's copy repeated inside the card.
          */}

          {/*
            The field labels are FabOrchestrator's — 14px, bold, sentence case,
            in the ink colour — rather than this app's `Label` primitive, which
            is 12px uppercase in `--text-subtle` and reads as a form built by a
            different hand. The primitive is untouched: it is used on six other
            screens, and restyling it to fix one would be a change nobody asked
            for on all of them.

            The mail and lock glyphs are FO's too. They carry no meaning the
            label does not already give, which is why they are `aria-hidden`;
            they are here because their absence is most of what made this form
            look like a different product.
          */}
          <label className="flex flex-col gap-[7px]">
            <span className="text-[14px] font-bold" style={{ color: "var(--text-ink)" }}>
              Work email
            </span>
            <div
              className="flex items-center gap-[11px] px-[15px] py-[13px]"
              style={{ background: "var(--field-bg)", borderRadius: "var(--r-control)" }}
            >
              <Mail
                size={18}
                strokeWidth={2}
                aria-hidden="true"
                className="flex-none"
                style={{ color: "var(--text-subtle)" }}
              />
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="name@company.com"
                /*
                  16px, not FabOrchestrator's 15.5px. iOS Safari zooms the page
                  in on any focused input below 16px and does not zoom back out,
                  which leaves the form wider than the screen mid-sign-in. The
                  half-pixel is not worth that.
                */
                className="w-full min-w-0 bg-transparent text-[16px] font-medium outline-none placeholder:font-normal"
                style={{ border: 0, color: "var(--text-ink)" }}
              />
            </div>
          </label>

          <label className="flex flex-col gap-[7px]">
            <span className="text-[14px] font-bold" style={{ color: "var(--text-ink)" }}>
              Password
            </span>
            <div
              className="flex items-center gap-[11px] px-[15px] py-[13px]"
              style={{ background: "var(--field-bg)", borderRadius: "var(--r-control)" }}
            >
              <Lock
                size={18}
                strokeWidth={2}
                aria-hidden="true"
                className="flex-none"
                style={{ color: "var(--text-subtle)" }}
              />
              <input
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                placeholder="••••••••••••"
                className="w-full min-w-0 bg-transparent text-[16px] font-medium outline-none placeholder:font-normal"
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
            disabled={busy || !hydrated}
            className="mt-1 w-full justify-center py-[15px] text-[16px]"
            style={{ borderRadius: 13 }}
          >
            {busy ? "Signing in…" : "Sign in"}
            {/* FO's arrow, and only when there is nothing else to say. A spinner
                label plus a "go" arrow reads as two conflicting states. */}
            {busy ? null : <ArrowRight size={17} strokeWidth={2.4} aria-hidden="true" />}
          </Button>

          {/*
            FabOrchestrator closes its card with this line. It is a statement,
            not a control, so it carries none of the risk that kept the SSO
            buttons, the reset link and "keep me signed in" off this form — and
            it is true here for the same reason it is true there: the connection
            is HTTPS-only, enforced in `foBaseUrl()`.
          */}
          <p
            className="m-0 -mt-[4px] flex items-center justify-center gap-[7px] text-[12px] font-medium"
            style={{ color: "var(--text-subtle)" }}
          >
            <Lock size={14} strokeWidth={2} aria-hidden="true" />
            Protected with enterprise-grade encryption
          </p>
        </form>
      </main>
    </div>
  );
}
