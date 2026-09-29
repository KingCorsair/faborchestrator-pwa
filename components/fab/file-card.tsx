"use client";

/**
 * A file FabOrchestrator made — a PowerPoint deck, a spreadsheet, a PDF —
 * offered for download beneath the answer it came with (2026-09-29).
 *
 * Laid out like the dashboard tile beside it, so the two read as one family:
 * what it is, how big, and one action. The download goes through this app's
 * own route, which proves the file is the operator's before fetching it
 * (`app/api/faborch/files/[fileId]/route.ts`), and lands wherever this device
 * keeps files (`lib/save-file.ts`).
 */

import * as React from "react";
import {
  Check,
  Download,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Presentation,
} from "lucide-react";
import { fileKind, fileKindLabel, formatBytes, type FileKind, type FoFile } from "@/lib/faborch/files";
import { markFoActivity } from "@/lib/fo-activity";
import { saveFile } from "@/lib/save-file";

const ICON: Record<FileKind, typeof FileIcon> = {
  presentation: Presentation,
  spreadsheet: FileSpreadsheet,
  document: FileText,
  pdf: FileText,
  image: ImageIcon,
  file: FileIcon,
};

/** FO writes the file into the conversation a moment after announcing it. */
const NOT_SAVED_YET_RETRY_MS = 2_000;

async function fetchFile(fileId: string, conversationId: string): Promise<Blob> {
  const url = `/api/faborch/files/${encodeURIComponent(fileId)}?c=${encodeURIComponent(conversationId)}`;
  const headers = { Authorization: `Bearer ${localStorage.getItem("llmatscale_auth_token") ?? ""}` };

  let res = await fetch(url, { headers });
  // Pressed the instant the card appeared: FO may not have saved it yet.
  if (res.status === 404) {
    await new Promise((resolve) => setTimeout(resolve, NOT_SAVED_YET_RETRY_MS));
    res = await fetch(url, { headers });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "The file could not be downloaded.");
  }
  return res.blob();
}

export function FileCard({ file, conversationId }: { file: FoFile; conversationId: string | null }) {
  const [state, setState] = React.useState<"idle" | "busy" | "done" | "failed">("idle");
  const [problem, setProblem] = React.useState("");

  const kind = fileKind(file);
  const Icon = ICON[kind];
  const meta = [fileKindLabel(kind), formatBytes(file.sizeBytes)].filter(Boolean).join(" · ");

  const download = async () => {
    if (!conversationId || state === "busy") return;
    setState("busy");
    setProblem("");
    try {
      const blob = await fetchFile(file.fileId, conversationId);
      // A request FabOrchestrator served resets its idle clock.
      markFoActivity();
      const outcome = await saveFile(blob, file.filename);
      setState(outcome === "cancelled" ? "idle" : "done");
    } catch (error) {
      setState("failed");
      setProblem(error instanceof Error ? error.message : "The file could not be downloaded.");
    }
  };

  return (
    <div className="fab-card flex flex-col gap-[8px] px-[16px] py-[14px]">
      <div className="flex items-center gap-[13px]">
        <span
          className="grid h-[36px] w-[36px] flex-none place-items-center"
          style={{
            borderRadius: "var(--r-control)",
            background: "var(--cockpit-surface)",
            color: "var(--brand-indigo)",
          }}
          aria-hidden="true"
        >
          <Icon size={17} strokeWidth={2} />
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="truncate text-[14px] font-bold" style={{ color: "var(--text-ink)" }}>
            {file.filename}
          </span>
          <span className="text-[12px] font-normal" style={{ color: "var(--text-subtle)" }}>
            {meta}
          </span>
        </span>

        <button
          type="button"
          onClick={download}
          disabled={!conversationId || state === "busy"}
          aria-label={`Download ${file.filename}`}
          className="flex min-h-[38px] flex-none cursor-pointer items-center gap-[6px] border-0 px-[12px] text-[12px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            borderRadius: "var(--r-control)",
            background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))",
          }}
        >
          {state === "done" ? (
            <Check size={14} strokeWidth={2.6} aria-hidden="true" />
          ) : (
            <Download size={14} strokeWidth={2.4} aria-hidden="true" />
          )}
          {state === "busy" ? "Preparing…" : state === "done" ? "Saved" : "Download"}
        </button>
      </div>

      {state === "failed" ? (
        <p className="m-0 text-[12px] font-normal leading-[1.6]" style={{ color: "var(--status-amber-ink)" }} role="status">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
