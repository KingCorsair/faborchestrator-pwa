"use client";

/**
 * A dashboard, as a tile in the answer.
 *
 * ── Why a tile and not an inline frame ──────────────────────────────────────
 * FabOrchestrator shows artifacts inline, in a side panel, on a desktop canvas
 * with room for both. A phone has one column. Dropping a 1024px-wide dashboard
 * into the middle of a conversation pushes the answer off screen and leaves the
 * operator scrolling past a chart to reach the sentence that explains it.
 *
 * So the answer stays readable and the artifact becomes something to open. The
 * tile carries what is needed to decide whether to: its title, its kind, and
 * whether it has finished arriving.
 */

import { BarChart3, ChevronRight, Code2, FileText, Image as ImageIcon } from "lucide-react";
import type { FoArtifact } from "@/lib/faborch/artifacts";
import { typeLabel } from "@/lib/faborch/artifacts";

function IconFor({ type }: { type: string }) {
  const t = type.toLowerCase();
  const props = { size: 17, strokeWidth: 2, "aria-hidden": true } as const;
  if (t === "text/html") return <BarChart3 {...props} />;
  if (t === "image/svg+xml") return <ImageIcon {...props} />;
  if (t === "text/markdown") return <FileText {...props} />;
  return <Code2 {...props} />;
}

export function ArtifactTile({
  artifact,
  isStreaming,
  onOpen,
}: {
  artifact: FoArtifact;
  isStreaming: boolean;
  onOpen: () => void;
}) {
  /*
    While it is still arriving the tile is not a button.

    A half-written document opens to a half-drawn dashboard, and the operator
    reads that as a broken chart rather than an unfinished one. The plan's rule
    is a "building" placeholder with the title — which is exactly what is known
    at that point, since the title arrives in the opening tag while the body is
    still streaming.
  */
  if (isStreaming) {
    return (
      <div
        className="fab-card flex items-center gap-[13px] px-[16px] py-[14px]"
        role="status"
        aria-label={`Building ${artifact.title}`}
      >
        <span className="flex gap-[3px]" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="fab-pulse block h-[5px] w-[5px] rounded-full"
              style={{ background: "var(--brand-indigo)", animationDelay: `${i * 180}ms` }}
            />
          ))}
        </span>
        <span className="flex min-w-0 flex-col gap-[2px]">
          <span className="truncate text-[14px] font-bold" style={{ color: "var(--text-ink)" }}>
            {artifact.title}
          </span>
          <span className="text-[12px] font-normal" style={{ color: "var(--text-subtle)" }}>
            Building…
          </span>
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="fab-card fab-card-link flex w-full cursor-pointer items-center gap-[13px] px-[16px] py-[14px] text-left"
    >
      <span
        className="grid h-[36px] w-[36px] flex-none place-items-center"
        style={{
          borderRadius: "var(--r-control)",
          background: "var(--cockpit-surface)",
          color: "var(--brand-indigo)",
        }}
      >
        <IconFor type={artifact.type} />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="truncate text-[14px] font-bold" style={{ color: "var(--text-ink)" }}>
          {artifact.title}
        </span>
        <span className="text-[12px] font-normal" style={{ color: "var(--text-subtle)" }}>
          {typeLabel(artifact.type)} · tap to open
        </span>
      </span>

      <ChevronRight
        size={17}
        strokeWidth={2.2}
        aria-hidden="true"
        className="flex-none"
        style={{ color: "var(--text-subtle)" }}
      />
    </button>
  );
}
