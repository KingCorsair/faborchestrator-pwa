/**
 * The frame the device screens share: the blocked page and the enrollment
 * page. The sign-in card's look (`components/login-page.tsx`), without its
 * brand panel: these are short, single-purpose screens on a phone.
 */

import * as React from "react";
import { BrandLockup } from "@/components/fab/brand";

export function DeviceCard({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <div className="fab flex min-h-full items-center justify-center p-6" style={{ background: "var(--page-surface)" }}>
      <main
        className="fab-card flex w-full max-w-[440px] flex-col gap-[18px]"
        style={{ padding: "36px 32px", boxShadow: "0 24px 60px rgba(16,21,58,.16)" }}
      >
        <BrandLockup />
        <span
          className="inline-flex w-fit items-center gap-2 px-[13px] py-[7px] text-[12px] font-extrabold tracking-[0.05em]"
          style={{ borderRadius: 20, color: "var(--cockpit-indigo)", background: "var(--brand-indigo-bg)" }}
        >
          {eyebrow}
        </span>
        <h1 className="text-[24px]">{title}</h1>
        {children}
      </main>
    </div>
  );
}

export function Notice({ tone, children }: { tone: "error" | "info" | "ok"; children: React.ReactNode }) {
  const style: React.CSSProperties =
    tone === "error"
      ? { background: "var(--status-red-bg)", border: "1px solid var(--status-red-border)", color: "var(--status-red)" }
      : tone === "ok"
        ? { background: "var(--status-green-bg, #E8F7EE)", border: "1px solid var(--status-green-border, #B7E4C7)", color: "var(--text-ink)" }
        : { background: "var(--brand-indigo-bg)", color: "var(--text-ink)" };
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className="m-0 px-4 py-[10px] text-[14px] leading-[1.5]"
      style={{ borderRadius: "var(--r-control)", ...style }}
    >
      {children}
    </p>
  );
}

export const fieldShell: React.CSSProperties = { background: "var(--field-bg)", borderRadius: "var(--r-control)" };
export const fieldInput: React.CSSProperties = { border: 0, color: "var(--text-ink)" };
