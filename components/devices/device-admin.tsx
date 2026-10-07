"use client";

/**
 * Device administration: create a one-time enrollment (QR code, link, expiry),
 * see enrolled devices, revoke one. An enrollment names no user: the code
 * authorizes one device, and who uses the device is decided at sign-in.
 *
 * Revoking asks for a second tap on the same row rather than a browser
 * `confirm()`, which blocks the page and which a standalone app on some phones
 * does not show at all.
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

  const refresh = React.useCallback(async () => {
    const [list, open] = await Promise.all([
      call<{ devices: DeviceView[] }>("/api/pwa/devices"),
      call<{ enrollments: EnrollmentView[] }>("/api/pwa/device-enrollments"),
    ]);
    if (!list.ok) {
      setProblem(list);
      return;
    }
    setProblem(null);
    setDevices(list.body.devices);
    if (open.ok) setPending(open.body.enrollments);
  }, []);

  React.useEffect(() => {
    void refresh();
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
      <section className="fab-card flex flex-col gap-4" style={{ padding: 24 }}>
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
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Creating…" : "Create Device Enrollment"}
            </Button>
          </div>
        </form>
        {createError ? <Notice tone="error">{createError}</Notice> : null}
        {issued ? <IssuedEnrollment issued={issued} onDone={() => setIssued(null)} /> : null}
      </section>

      {pending.length > 0 ? (
        <section className="fab-card flex flex-col gap-3" style={{ padding: 24 }}>
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

      <section className="fab-card flex flex-col gap-3" style={{ padding: 24 }}>
        <Label as="h2">Devices</Label>
        {problem ? <Notice tone="error">{problem.error}</Notice> : null}
        {devices === null ? (
          <p className="m-0 text-[14px]">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="m-0 text-[14px]">No device has been enrolled yet.</p>
        ) : (
          <div className="overflow-x-auto">
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
                    <td className="whitespace-nowrap py-2 pr-3 font-semibold tabular-nums">{d.deviceId}</td>
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
                        <Button variant={confirming === d.deviceId ? "primary" : "secondary"} onClick={() => void revoke(d.deviceId)}>
                          {confirming === d.deviceId ? "Confirm revoke" : "Revoke"}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fab min-h-full p-6" style={{ background: "var(--page-surface)" }}>
      <div className="mx-auto flex max-w-[1100px] flex-col gap-5">
        <header className="flex items-center justify-between gap-4">
          <BrandLockup />
          <h1 className="m-0 text-[20px]">Approved devices</h1>
        </header>
        {children}
      </div>
    </div>
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
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
      {/* eslint-disable-next-line @next/next/no-img-element -- an inline SVG data URI, nothing to optimise */}
      <img
        src={`data:image/svg+xml;utf8,${encodeURIComponent(issued.qrSvg)}`}
        alt="One-time enrollment QR code"
        width={220}
        height={220}
        style={{ opacity: left > 0 ? 1 : 0.2 }}
      />
      <div className="flex min-w-0 flex-col gap-2 text-[14px]">
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
          Scan it on the device to approve it. It works once. The link, for pasting into the installed app on an
          iPhone:
        </span>
        <code className="break-all text-[12px]">{issued.url}</code>
        <div className="flex gap-2">
          <Button onClick={() => void navigator.clipboard?.writeText(issued.url).catch(() => {})}>Copy link</Button>
          <Button variant="ghost" onClick={onDone}>
            Hide
          </Button>
        </div>
      </div>
    </div>
  );
}
