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
import { DEFAULT_RETURN_PATH } from "@/lib/return-path";

const AUTH_TOKEN_KEY = "llmatscale_auth_token";
const AUTH_SESSION_KEY = "llmatscale_auth_session";

export interface LoginPageProps {
  /**
   * Prefills the email field. Empty unless the deployment opts in — see
   * `app/page.tsx` for why that is a switch and not a default.
   */
  defaultEmail?: string;
  /**
   * Where to go once signed in. Validated by the route before it reaches here —
   * this component never sees a value it should not navigate to, which is why
   * it does no checking of its own.
   */
  next?: string;
  /**
   * The visitor is signed in here already and has come to add a
   * **FabOrchestrator** session on top — the agent screens' "Sign in to
   * FabOrchestrator" card sets it.
   *
   * Without it the guard below bounces them back before they can type, which is
   * what made that card a dead control: it is only ever shown to somebody who
   * has a token, so its own audience was exactly the audience the guard turned
   * away. See `components/fab/screens/agent-chat.tsx`.
   */
  upgrade?: boolean;
}

export function LoginPage({
  defaultEmail = "",
  next = DEFAULT_RETURN_PATH,
  upgrade = false,
}: LoginPageProps) {
  const router = useRouter();
  const [email, setEmail] = React.useState(defaultEmail);
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // An operator who is already signed in should never see this form — unless
  // they came here on purpose to add a FabOrchestrator session, which is the
  // one case where "already signed in" and "has the session they need" are
  // different things. There are two kinds of session now; this guard predates
  // the second.
  React.useEffect(() => {
    if (upgrade) return;
    if (localStorage.getItem(AUTH_TOKEN_KEY)) router.replace(next);
  }, [router, next, upgrade]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
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
          onSubmit={onSubmit}
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

          <h1 className="text-[26px]">Sign in to FabOrchestrator</h1>

          {/*
            Says which credential to use, on the screen where it is typed.

            The route accepts two (`app/api/auth/login/route.ts`) and a
            FabOrchestrator one opens **everything** — the four agents and the
            production order workflow — while the demo credential opens the
            workflow alone. Until 2026-08-24 the screen said only "Sign in" and,
            on the deployed app, prefilled the demo address, so people signed in
            with the credential that cannot reach the agents and met a second
            sign-in the moment they opened one. Being asked to sign in twice for
            one journey is the complaint this line exists to prevent.
          */}
          <p
            className="m-0 -mt-[6px] max-w-[var(--measure)] text-[12px] font-normal leading-[1.6]"
            style={{ color: "var(--text-muted-cool)" }}
          >
            Use your FabOrchestrator account. It opens the agents and the production
            order workflow, and the agents answer with your tools, your role and your
            data.
          </p>

          <label className="flex flex-col gap-[7px]">
            <Label>Email</Label>
            <div
              className="flex items-center gap-[11px] px-[15px] py-[13px]"
              style={{ background: "var(--field-bg)", borderRadius: "var(--r-control)" }}
            >
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
            disabled={busy}
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
