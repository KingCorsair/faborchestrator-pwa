/**
 * Files FabOrchestrator makes — a PowerPoint deck, a spreadsheet, a PDF — and
 * dashboards saved as files (2026-09-29).
 *
 * ── Where a file comes from ──────────────────────────────────────────────────
 * When FO's model writes a file with its code-execution tool, FO announces it
 * at the end of the answer as a `data-fileDownload` frame and saves it with the
 * message as a `file-download` part: `{ fileId, filename, mimeType, sizeBytes }`
 * (`claudeai_athena/app/api/chat/route.ts`, "Extract file_ids"). It does this
 * only for a turn written into a conversation. The bytes are held by
 * Anthropic's Files API, for 30 days, and FO serves them at
 * `GET /api/files/{fileId}/download`.
 *
 * Until now this app dropped both the frame and the part, so a deck the
 * operator asked for never appeared. This module is what the stream, the
 * stored-thread reader and the screen share about a file. No React, no fetch.
 */

/** One file FabOrchestrator made, as it announces it. */
export interface FoFile {
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * FO's file ids: `file_` and the Files API's own characters.
 *
 * Checked wherever an id arrives — from FO's stream, from a stored thread, and
 * in the download route's URL — because it is put into a request path. FO's
 * own route accepts `[a-zA-Z0-9_-]+`; this is that, plus the prefix FO itself
 * requires before it announces a file.
 */
const FILE_ID = /^file_[A-Za-z0-9_-]{1,200}$/;

export function isFileId(value: unknown): value is string {
  return typeof value === "string" && FILE_ID.test(value);
}

/**
 * A file from whatever FO sent — a stream frame's `data`, or a stored part —
 * or null when there is no usable id. The rest is display, and is defaulted
 * the way FO defaults it.
 */
export function toFoFile(value: unknown): FoFile | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isFileId(v.fileId)) return null;
  return {
    fileId: v.fileId,
    filename: typeof v.filename === "string" && v.filename.trim() ? v.filename.trim() : "download",
    mimeType: typeof v.mimeType === "string" && v.mimeType ? v.mimeType : "application/octet-stream",
    sizeBytes: typeof v.sizeBytes === "number" && Number.isFinite(v.sizeBytes) && v.sizeBytes > 0 ? v.sizeBytes : 0,
  };
}

/**
 * Does a stored conversation carry this file? The download route's proof that
 * the file is the caller's (FO's own download route does not check).
 */
export function conversationHasFile(messages: unknown, fileId: string): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    const parts = (message as { parts?: unknown } | null)?.parts;
    return (
      Array.isArray(parts) &&
      parts.some(
        (part) =>
          !!part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "file-download" &&
          (part as { fileId?: unknown }).fileId === fileId,
      )
    );
  });
}

/** Add a file to a list, once: FO can announce the same file twice. */
export function withFile(files: FoFile[] | undefined, file: FoFile): FoFile[] {
  const list = files ?? [];
  return list.some((f) => f.fileId === file.fileId) ? list : [...list, file];
}

export type FileKind = "presentation" | "spreadsheet" | "document" | "pdf" | "image" | "file";

/** What a file is, for its icon and its label — by extension, then by type. */
export function fileKind(file: Pick<FoFile, "filename" | "mimeType">): FileKind {
  const ext = file.filename.split(".").pop()?.toLowerCase() ?? "";
  const mime = file.mimeType.toLowerCase();
  if (["pptx", "ppt", "key", "odp"].includes(ext) || mime.includes("presentation")) return "presentation";
  if (["xlsx", "xls", "csv", "ods"].includes(ext) || mime.includes("spreadsheet") || mime === "text/csv") {
    return "spreadsheet";
  }
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (["docx", "doc", "odt", "md", "txt", "rtf"].includes(ext) || mime.includes("wordprocessing")) return "document";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext) || mime.startsWith("image/")) return "image";
  return "file";
}

const KIND_LABEL: Record<FileKind, string> = {
  presentation: "PowerPoint",
  spreadsheet: "Spreadsheet",
  document: "Document",
  pdf: "PDF",
  image: "Image",
  file: "File",
};

export function fileKindLabel(kind: FileKind): string {
  return KIND_LABEL[kind];
}

/** `1.2 MB`, `640 KB`; nothing when FO did not say. */
export function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── A dashboard, saved as a file ─────────────────────────────────────────── */

/**
 * The file a dashboard is saved as: its extension and type by the artifact's
 * MIME type, and its name from its title.
 *
 * FO's website saves exactly the artifact's source (`handleDownload` in
 * `components/artifact-preview.tsx`), so this does too — not the light-mode
 * copy this app frames, which is an adjustment for a phone screen and not
 * FabOrchestrator's document.
 */
export function artifactFile(artifact: { type: string; title: string }): { filename: string; mimeType: string } {
  const type = artifact.type.toLowerCase();
  const [ext, mimeType] =
    type === "text/html"
      ? ["html", "text/html"]
      : type === "image/svg+xml"
        ? ["svg", "image/svg+xml"]
        : type === "text/markdown"
          ? ["md", "text/markdown"]
          : ["txt", "text/plain"];
  return { filename: `${safeName(artifact.title)}.${ext}`, mimeType: `${mimeType};charset=utf-8` };
}

/**
 * A title made safe to be a filename on every phone and desktop: letters,
 * digits, dashes and underscores, never empty, never absurdly long.
 */
export function safeName(title: string): string {
  const name = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 80)
    .replace(/_+$/, "");
  return name || "dashboard";
}
