"use client";

/**
 * Device administration: create a one-time enrollment (QR code, link, expiry),
 * see enrolled devices, revoke one. An enrollment names no user: the code
 * authorizes one device, and who uses the device is decided at sign-in.
 *
 * Revoking asks for a second tap on the same row rather than a browser
 * `confirm()`, which blocks the page and which a standalone app on some phones
 * does not show at all.
 *
 * On a phone (13 October 2026) the device list is a column of cards rather
 * than the eight-column table, whose Revoke button sat off-screen to the
 * right; the page keeps clear of the notch and the home indicator in the
 * installed app, and its buttons are full width.
 */

import * as React from "react";
import { BrandLockup } from "@/components/fab/brand";
import { Button, Label } from "@/components/fab/primitives";
import type { DeviceView, EnrollmentView } from "@/lib/devices/views";
import { bearerHeader } from "@/lib/stored-session";
import { fieldInput, fieldShell, Notice } from "./device-card";

type Issued = { enrollment: EnrollmentView; url: string; qrSvg: string };

async function call<T>(path: string, init: RequestInit = {}): Promise<{ ok: true; body: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Authorization: bearerHeader(), ...(init.headers ?? {}) },
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (res.ok && body) return { ok: true, body };
    return { ok: false, status: res.status, error: body?.error ?? `The server answered ${res.status}.` };
  } catch {
    return { ok: false, status: 0, error: "Could not reach the server." };
  }
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export function DeviceAdmin() {
  const [devices, setDevices] = React.useState<DeviceView[] | null>(null);
  const [pending, setPending] = React.useState<EnrollmentView[]>([]);
  const [problem, setProblem] = React.useState<{ status: number; error: string } | null>(null);
  const [issued, setIssued] = React.useState<Issued | null>(null);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [current, setCurrent] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const [list, open] = await Promise.all([
      call<{ devices: DeviceView[]; currentDeviceId: string | null }>("/api/pwa/devices"),
      call<{ enrollments: EnrollmentView[] }>("/api/pwa/device-enrollments"),
    ]);
    if (!list.ok) {
      setProblem(list);
      return;
    }
    setProblem(null);
    setDevices(list.body.devices);
    setCurrent(list.body.currentDeviceId ?? null);
    if (open.ok) setPending(open.body.enrollments);
  }, []);

  // Refreshed every few seconds while the page is visible, so a phone that
  // enrolls appears here without a reload (it was easy to revoke the wrong
  // row from a stale list).
  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setCreateError(null);
    const result = await call<Issued>("/api/pwa/device-enrollments", {
      method: "POST",
      body: JSON.stringify({
        site: String(form.get("site") ?? "") || undefined,
        friendlyName: String(form.get("friendlyName") ?? "") || undefined,
      }),
    });
    setBusy(false);
    if (!result.ok) {
      setCreateError(result.error);
      return;
    }
    setIssued(result.body);
    void refresh();
  }

  async function revoke(deviceId: string) {
    if (confirming !== deviceId) {
      setConfirming(deviceId);
      return;
    }
    setConfirming(null);
    const result = await call(`/api/pwa/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!result.ok) setProblem(result);
    void refresh();
  }

  if (problem && devices === null) {
    return (
      <Shell>
        <Notice tone="error">
          {problem.status === 401
            ? "Sign in first, with a device administrator's account."
            : problem.status === 403
              ? "Only a device administrator can manage devices."
              : problem.error}
        </Notice>
        {problem.status === 401 ? (
          <a href="/login?next=%2Fdevice-admin" className="font-bold underline" style={{ color: "var(--cockpit-indigo)" }}>
            Sign in
          </a>
        ) : null}
      </Shell>
    );
  }

  return (
    <Shell>
      <section className="fab-card flex flex-col gap-4 p-[18px] sm:p-6">
        <Label as="h2">Create device enrollment</Label>
        <p className="m-0 text-[14px]" style={{ color: "var(--text-muted-cool)" }}>
          A one-time QR code that approves one device. Scanning it enrolls the device at once, with no sign-in; it
          expires in minutes and works once. Whoever then uses the device still signs in to FabOrchestrator as
          usual. Business approval for the device must already be in place.
        </p>
        <form onSubmit={onCreate} className="grid gap-3 sm:grid-cols-2">
          <Field name="friendlyName" label="Device name (optional)" />
          <Field name="site" label="Site (optional)" />
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center sm:w-auto">
              {busy ? "Creating…" : "Create Device Enrollment"}
            </Button>
          </div>
        </form>
        {createError ? <Notice tone="error">{createError}</Notice> : null}
        {issued ? <IssuedEnrollment issued={issued} onDone={() => setIssued(null)} /> : null}
      </section>

      {pending.length > 0 ? (
        <section className="fab-card flex flex-col gap-3 p-[18px] sm:p-6">
          <Label as="h2">Waiting to be used</Label>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[14px]">
            {pending.map((e) => (
              <li key={e.enrollmentId}>
                <strong>{e.friendlyName ?? "Unnamed device"}</strong>
                {e.site ? ` · ${e.site}` : ""} · expires {when(e.expiresAt)} · by {e.createdBy}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="fab-card flex flex-col gap-3 p-[18px] sm:p-6">
        <Label as="h2">Devices</Label>
        {problem ? <Notice tone="error">{problem.error}</Notice> : null}
        {devices === null ? (
          <p className="m-0 text-[14px]">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="m-0 text-[14px]">No device has been enrolled yet.</p>
        ) : (
          <>
            {/* Phones: one card per device. */}
            <ul className="m-0 flex list-none flex-col gap-3 p-0 md:hidden">
              {devices.map((d) => (
                <li
                  key={d.deviceId}
                  className="flex flex-col gap-3 p-[14px]"
                  style={{ border: "1px solid var(--border-light)", borderRadius: 12 }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-[3px]">
                      <strong className="break-words text-[15px]">{d.friendlyName}</strong>
                      <span className="flex flex-wrap items-center gap-2 text-[13px] font-semibold tabular-nums">
                        {d.deviceId}
                        {d.deviceId === current ? <ThisDevice /> : null}
                      </span>
                    </div>
                    <span
                      className="shrink-0 text-[12px] font-bold"
                      style={{ color: d.status === "APPROVED" ? "var(--status-green-ink)" : "var(--status-red)" }}
                    >
                      {d.status}
                    </span>
                  </div>
                  <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-[5px] text-[12px]">
                    <Row label="Device">
                      {d.deviceType} · {d.os} · {d.browser} · {d.context}
                    </Row>
                    <Row label="Enrolled">{when(d.createdAt)}</Row>
                    <Row label="Issued by">{d.createdBy}</Row>
                    <Row label="Last seen">{when(d.lastSeenAt)}</Row>
                    {d.status === "REVOKED" ? (
                      <Row label="Revoked">
                        {when(d.revokedAt)} by {d.revokedBy}
                      </Row>
                    ) : null}
                    <Row label="Key">{d.keyFingerprint.slice(0, 12)}</Row>
                  </dl>
                  {d.status === "APPROVED" ? (
                    <RevokeButton
                      confirming={confirming === d.deviceId}
                      isCurrent={d.deviceId === current}
                      onClick={() => void revoke(d.deviceId)}
                      className="w-full justify-center py-[11px]"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
            {/* Wider screens: the table. */}
            <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-[13px]" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "var(--text-subtle)" }}>
                  {["Device name", "Device ID", "Device type", "Status", "Enrolled", "Issued by", "Last seen", ""].map((h) => (
                    <th key={h} className="py-2 pr-3 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.deviceId} style={{ borderTop: "1px solid var(--border-light)" }}>
                    <td className="py-2 pr-3">{d.friendlyName}</td>
                    <td className="whitespace-nowrap py-2 pr-3 font-semibold tabular-nums">
                      {d.deviceId}
                      {d.deviceId === current ? <ThisDevice className="ml-2" /> : null}
                      <span className="block text-[11px] font-normal" style={{ color: "var(--text-subtle)" }} title="Public-key fingerprint">
                        key {d.keyFingerprint.slice(0, 12)}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      {d.deviceType} · {d.os} · {d.browser} · {d.context}
                    </td>
                    <td className="py-2 pr-3">
                      <span style={{ color: d.status === "APPROVED" ? "var(--status-green-ink)" : "var(--status-red)" }}>
                        {d.status}
                      </span>
                      {d.status === "REVOKED" ? (
                        <span className="block text-[12px]" style={{ color: "var(--text-subtle)" }}>
                          {when(d.revokedAt)} by {d.revokedBy}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">{when(d.createdAt)}</td>
                    <td className="py-2 pr-3">{d.createdBy}</td>
                    <td className="py-2 pr-3">{when(d.lastSeenAt)}</td>
                    <td className="py-2">
                      {d.status === "APPROVED" ? (
                        <RevokeButton
                          confirming={confirming === d.deviceId}
                          isCurrent={d.deviceId === current}
                          onClick={() => void revoke(d.deviceId)}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
        )}
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="fab min-h-full px-4 sm:px-6"
      style={{
        background: "var(--page-surface)",
        // Clear of the notch and the home indicator in the installed app.
        paddingTop: "calc(env(safe-area-inset-top, 0px) + 12px)",
        paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 24px)",
      }}
    >
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4 sm:gap-5">
        {/* Reached from the Devices button on FabOrchestrator's pages; a
            whole-page link back, since FabOrchestrator is a separate app. A
            44px row, so it is easy to hit with a thumb. */}
        <a
          href="/home"
          className="inline-flex min-h-[44px] w-fit items-center text-[14px] font-bold no-underline"
          style={{ color: "var(--cockpit-indigo)" }}
        >
          ← Back to FabOrchestrator
        </a>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <BrandLockup />
          <h1 className="m-0 text-[18px] sm:text-[20px]">Approved devices</h1>
        </header>
        {children}
      </div>
    </div>
  );
}

function ThisDevice({ className = "" }: { className?: string }) {
  return (
    <span
      className={`rounded px-[6px] py-[1px] text-[11px] font-bold ${className}`}
      style={{ background: "var(--brand-indigo-bg)", color: "var(--cockpit-indigo)" }}
    >
      This device
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: "var(--text-subtle)" }}>{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}

function RevokeButton({
  confirming,
  isCurrent,
  onClick,
  className,
}: {
  confirming: boolean;
  isCurrent: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button variant={confirming ? "primary" : "secondary"} onClick={onClick} className={className}>
      {confirming ? (isCurrent ? "Revoke this device? You will lose access" : "Confirm revoke") : "Revoke"}
    </Button>
  );
}

function Field({ name, label, type = "text", required = false }: { name: string; label: string; type?: string; required?: boolean }) {
  return (
    <label className="flex flex-col gap-[7px]">
      <Label>{label}</Label>
      <div className="flex items-center px-[15px] py-[11px]" style={fieldShell}>
        <input
          name={name}
          type={type}
          required={required}
          autoComplete="off"
          className="w-full min-w-0 bg-transparent text-[15px] outline-none"
          style={fieldInput}
        />
      </div>
    </label>
  );
}

function IssuedEnrollment({ issued, onDone }: { issued: Issued; onDone: () => void }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, new Date(issued.enrollment.expiresAt ?? 0).getTime() - now);
  const minutes = Math.floor(left / 60000);
  const seconds = Math.floor((left % 60000) / 1000);

  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center">
      {/* eslint-disable-next-line @next/next/no-img-element -- an inline SVG data URI, nothing to optimise */}
      <img
        src={`data:image/svg+xml;utf8,${encodeURIComponent(issued.qrSvg)}`}
        alt="One-time enrollment QR code"
        width={220}
        height={220}
        style={{ opacity: left > 0 ? 1 : 0.2 }}
      />
      <div className="flex w-full min-w-0 flex-col gap-2 text-[14px] sm:w-auto">
        <span>
          <strong>One-time device enrollment</strong>
          {issued.enrollment.friendlyName ? ` · ${issued.enrollment.friendlyName}` : ""}
          {issued.enrollment.site ? ` · ${issued.enrollment.site}` : ""}
        </span>
        <span>
          {left > 0 ? (
            <>
              Expires in{" "}
              <strong>
                {minutes}:{String(seconds).padStart(2, "0")}
              </strong>{" "}
              ({new Date(issued.enrollment.expiresAt ?? 0).toLocaleTimeString()})
            </>
          ) : (
            <strong>Expired</strong>
          )}
        </span>
        <span className="text-[12px]" style={{ color: "var(--text-subtle)" }}>
          Works once. A phone camera approves the browser it opens in; to approve an installed app, use the app&rsquo;s
          own &ldquo;Scan enrollment QR&rdquo; (on an iPhone this matters: Safari and the app are separate). The link,
          for pasting instead:
        </span>
        <code className="break-all text-[12px]">{issued.url}</code>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void navigator.clipboard?.writeText(issued.url).catch(() => {})}>Copy link</Button>
          <Button variant="ghost" onClick={onDone}>
            Hide
          </Button>
        </div>
      </div>
    </div>
  );
}
