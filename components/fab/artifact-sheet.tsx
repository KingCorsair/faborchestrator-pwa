"use client";

/**
 * A dashboard, full screen, in a sandbox it cannot escape.
 *
 * ── The sandbox, and the one combination that must never appear ─────────────
 * `sandbox="allow-scripts"` and deliberately **without** `allow-same-origin`.
 *
 * Those two flags together cancel the sandbox: the frame inherits the
 * embedder's origin and can read its cookies, storage and DOM. FabOrchestrator's
 * own pages use both, which is survivable there because frame and page share an
 * origin anyway. It is not survivable here — this app holds an httpOnly
 * FabOrchestrator token, and the document in the frame was written by a model
 * from data the operator asked about.
 *
 * With `allow-scripts` alone the frame gets an **opaque origin**: charts run,
 * and nothing they run can reach this app. The same decision already ships in
 * `/reports`, and a test asserts the pair never appears together.
 *
 * ── Accepted, stated risk ───────────────────────────────────────────────────
 * FO's artifacts pull Tailwind and Google Fonts from CDNs, so the frame needs
 * the network. Blocking it would leave the dashboard unstyled, which is worse
 * than the risk. It is recorded here as accepted rather than left silent: the
 * frame can make outbound requests to whatever the document references, and it
 * carries `referrerpolicy="no-referrer"` so those requests say nothing about
 * where they came from.
 *
 * ── Never a blank rectangle ─────────────────────────────────────────────────
 * The plan's fallback rule. Three ways this can fail and what each shows:
 *   - a type this app does not frame  → the source, as a readable code block
 *   - the frame reports an error      → a message, plus the source
 *   - the operator wants to check it  → "Show source" is always available
 */

import * as React from "react";
import { AlertTriangle, Code2, Eye, X } from "lucide-react";
import type { FoArtifact } from "@/lib/faborch/artifacts";
import { presentationFor, typeLabel } from "@/lib/faborch/artifacts";
import { enforceLightHtml } from "@/lib/faborch/enforce-light";

export function ArtifactSheet({
  artifact,
  onClose,
}: {
  artifact: FoArtifact;
  onClose: () => void;
}) {
  const framable = presentationFor(artifact.type) === "frame";
  const [showSource, setShowSource] = React.useState(!framable);
  const [failed, setFailed] = React.useState(false);

  // Escape closes it, as it would any dialog. The sheet covers the whole
  // screen, so there is nothing behind it to click away to.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sourceShown = showSource || failed || !framable;

  return (
    <div
      className="fab fixed inset-0 z-50 flex flex-col"
      style={{ background: "var(--page-surface)" }}
      role="dialog"
      aria-modal="true"
      aria-label={artifact.title}
    >
      <header
        className="flex flex-none items-center gap-[10px] border-b px-4 py-[10px] sm:px-6"
        style={{ borderColor: "var(--border-light)" }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center border-0 bg-transparent"
          style={{ color: "var(--text-muted-cool)" }}
        >
          <X size={19} strokeWidth={2.2} aria-hidden="true" />
        </button>

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] font-bold" style={{ color: "var(--text-ink)" }}>
            {artifact.title}
          </span>
          <span className="text-[11px] font-normal" style={{ color: "var(--text-subtle)" }}>
            {typeLabel(artifact.type)} · from FabOrchestrator
          </span>
        </span>

        {/* Offered even when the frame works: an operator who doubts a figure
            should be able to see what produced it without leaving the phone. */}
        {framable && !failed ? (
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            className="flex min-h-[44px] cursor-pointer items-center gap-[6px] border-0 bg-transparent px-[6px] text-[12px] font-bold"
            style={{ color: "var(--brand-indigo)" }}
          >
            {showSource ? (
              <>
                <Eye size={14} strokeWidth={2.4} aria-hidden="true" />
                View
              </>
            ) : (
              <>
                <Code2 size={14} strokeWidth={2.4} aria-hidden="true" />
                Source
              </>
            )}
          </button>
        ) : null}
      </header>

      {failed ? (
        <p
          className="m-0 flex flex-none items-start gap-[8px] px-4 py-[10px] text-[12px] font-normal leading-[1.6] sm:px-6"
          style={{ color: "var(--text-muted-cool)" }}
        >
          <AlertTriangle
            size={14}
            strokeWidth={2.2}
            aria-hidden="true"
            className="mt-[2px] flex-none"
            style={{ color: "var(--status-amber-ink)" }}
          />
          This dashboard could not be displayed. Its source is below, so nothing is
          hidden from you.
        </p>
      ) : null}

      {sourceShown ? (
        <pre
          className="m-0 min-h-0 flex-1 overflow-auto px-4 py-4 text-[11px] leading-[1.6] sm:px-6"
          style={{ color: "var(--text-muted-cool)" }}
        >
          <code>{artifact.content}</code>
        </pre>
      ) : (
        <iframe
          // Rendered light and given a viewport, because these are authored for
          // a desktop canvas — see lib/faborch/enforce-light.ts.
          srcDoc={enforceLightHtml(artifact.content)}
          title={artifact.title}
          // The whole security posture of this component. See the file header.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="min-h-0 w-full flex-1 border-0"
          style={{ background: "#ffffff" }}
        />
      )}
    </div>
  );
}
