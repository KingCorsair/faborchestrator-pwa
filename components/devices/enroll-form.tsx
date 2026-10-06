"use client";

/**
 * The enrollment sign-in. Uncontrolled fields read with FormData at submit, and
 * a button disabled until hydration, for the reasons `components/login-page.tsx`
 * records: typing before hydration is kept, and a submit that escapes React
 * can never put a password in a URL.
 */

import * as React from "react";
import { Button, Label } from "@/components/fab/primitives";
import { fieldInput, fieldShell, Notice } from "./device-card";

function isInstalledApp(): boolean {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

export function EnrollForm({ email, expiresAt }: { email: string; expiresAt: string }) {
  const [hydrated, setHydrated] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ deviceId: string; friendlyName: string } | null>(null);
  const [installed, setInstalled] = React.useState(true);

  React.useEffect(() => {
    setHydrated(true);
    setInstalled(isInstalledApp());
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pwa/device-enrollments/complete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
          installedApp: isInstalledApp(),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { device?: { deviceId: string; friendlyName: string }; error?: string }
        | null;
      if (res.ok && body?.device) {
        setDone(body.device);
        return;
      }
      setError(body?.error ?? "This device could not be enrolled. Try again.");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <>
        <Notice tone="ok">
          This device is now approved as <strong>{done.deviceId}</strong> ({done.friendlyName}).
        </Notice>
        <Button
          variant="primary"
          className="w-full justify-center py-[15px] text-[16px]"
          style={{ borderRadius: 13 }}
          onClick={() => window.location.replace("/login")}
        >
          Continue to sign in
        </Button>
      </>
    );
  }

  return (
    <form onSubmit={onSubmit} method="post" className="flex flex-col gap-[16px]">
      {!installed ? (
        <Notice tone="info">
          You are in the browser, not the installed app. On an iPhone, enrolling here does not enroll the Home Screen
          app: the two keep separate data, and the link works once. To enroll the app instead, stop here, copy the
          link (long-press the QR code in the Camera) and paste it on the installed app&rsquo;s &ldquo;not
          approved&rdquo; screen.
        </Notice>
      ) : null}
      <label className="flex flex-col gap-[7px]">
        <Label>Email</Label>
        <div className="flex items-center px-[15px] py-[13px]" style={fieldShell}>
          <input
            name="email"
            type="email"
            autoComplete="username"
            defaultValue={email}
            required
            className="w-full min-w-0 bg-transparent text-[16px] font-medium outline-none"
            style={fieldInput}
          />
        </div>
      </label>
      <label className="flex flex-col gap-[7px]">
        <Label>Password</Label>
        <div className="flex items-center px-[15px] py-[13px]" style={fieldShell}>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="w-full min-w-0 bg-transparent text-[16px] font-medium outline-none"
            style={fieldInput}
          />
        </div>
      </label>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className="m-0 text-[12px]" style={{ color: "var(--text-subtle)" }}>
        This link expires at {new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
      </p>
      <Button
        type="submit"
        variant="primary"
        disabled={busy || !hydrated}
        className="w-full justify-center py-[15px] text-[16px]"
        style={{ borderRadius: 13 }}
      >
        {busy ? "Enrolling…" : "Enroll this device"}
      </Button>
    </form>
  );
}
