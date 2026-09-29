/**
 * Downloads: dashboards saved as files, and the files FabOrchestrator's model
 * makes — a PowerPoint deck, a spreadsheet — offered beneath the answer
 * (2026-09-29).
 *
 * Asked for: "give download options to dashboard and ppt". FO announced files
 * with a `data-fileDownload` frame and saved them as `file-download` parts, and
 * this app dropped both, so a deck the operator asked for never appeared.
 *
 * What is pinned:
 *   a file is recognised in FO's stream, in a stored thread, and in a thread
 *     fetched back after a dropped connection — and only with a real file id
 *   an answer that is only a file is still an answer
 *   the download route fetches a file only once it has found it in one of the
 *     caller's own conversations (FO's own route does not check), and always
 *     serves it as an attachment that cannot run as a page here
 *   a dashboard is saved as FO's own document, under a name any device accepts
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.FABORCH_BASE_URL ??= "https://fo.test";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import {
  EMPTY_CONVERSATION,
  conversationReducer as reduce,
  type ConversationAction,
} from "@/lib/faborch/conversation";
import {
  artifactFile,
  conversationHasFile,
  fileKind,
  formatBytes,
  isFileId,
  safeName,
  toFoFile,
  withFile,
  type FoFile,
} from "@/lib/faborch/files";
import { toTurns } from "@/lib/faborch/history";
import { storedAnswer } from "@/lib/faborch/recover";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { createFoStreamParser } from "@/lib/faborch/stream";
import { GET as DOWNLOAD } from "@/app/api/faborch/files/[fileId]/route";

const DECK: FoFile = {
  fileId: "file_011CSeKpaiLQyG2fQZT7uQpk",
  filename: "WIP by line.pptx",
  mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  sizeBytes: 1_258_291,
};

/* ── What a file is ──────────────────────────────────────────────────────── */

describe("a file FabOrchestrator made", () => {
  test("only FO's own ids are file ids", () => {
    assert.ok(isFileId(DECK.fileId));
    for (const bad of ["", "file_", "../etc/passwd", "file_../x", "file_a/b", "FILE_x", "x_file_1", 7, null]) {
      assert.equal(isFileId(bad), false, String(bad));
    }
  });

  test("is read from whatever FO sent, with FO's defaults", () => {
    assert.deepEqual(toFoFile(DECK), DECK);
    assert.deepEqual(toFoFile({ fileId: DECK.fileId }), {
      fileId: DECK.fileId,
      filename: "download",
      mimeType: "application/octet-stream",
      sizeBytes: 0,
    });
    assert.equal(toFoFile({ filename: "deck.pptx" }), null, "no id, no file");
    assert.equal(toFoFile("file_1"), null);
  });

  test("announced twice, it is listed once", () => {
    assert.equal(withFile(withFile(undefined, DECK), DECK).length, 1);
  });

  test("is labelled by what it is", () => {
    assert.equal(fileKind(DECK), "presentation");
    assert.equal(fileKind({ filename: "scrap.xlsx", mimeType: "" }), "spreadsheet");
    assert.equal(fileKind({ filename: "lots.csv", mimeType: "text/csv" }), "spreadsheet");
    assert.equal(fileKind({ filename: "report.pdf", mimeType: "application/pdf" }), "pdf");
    assert.equal(fileKind({ filename: "notes.docx", mimeType: "" }), "document");
    assert.equal(fileKind({ filename: "chart.png", mimeType: "image/png" }), "image");
    assert.equal(fileKind({ filename: "blob", mimeType: "application/octet-stream" }), "file");
  });

  test("its size reads like a size", () => {
    assert.equal(formatBytes(0), "");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(655_360), "640 KB");
    assert.equal(formatBytes(DECK.sizeBytes), "1.2 MB");
  });
});

/* ── Where files arrive ──────────────────────────────────────────────────── */

describe("files arriving with an answer", () => {
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

  test("FO's stream announces one", () => {
    const events = createFoStreamParser().push(frame({ type: "data-fileDownload", data: DECK }));
    assert.deepEqual(events, [{ type: "file", file: DECK }]);
  });

  test("an announcement without a real id is ignored", () => {
    const events = createFoStreamParser().push(
      frame({ type: "data-fileDownload", data: { fileId: "../../etc", filename: "x" } }) +
        frame({ type: "data-fileDownload" }),
    );
    assert.deepEqual(events, []);
  });

  const ask: ConversationAction = { type: "ask", prompt: "A deck of WIP by line", userId: "u1", assistantId: "a1" };

  test("the file lands on the answer being written", () => {
    const s = [
      ask,
      { type: "delta", delta: "Here is the deck." },
      { type: "file", file: DECK },
      { type: "file", file: DECK },
      { type: "settled" },
    ].reduce<typeof EMPTY_CONVERSATION>((state, action) => reduce(state, action as ConversationAction), EMPTY_CONVERSATION);
    assert.deepEqual(s.turns[1]!.files, [DECK]);
    assert.equal(s.turns[0]!.files, undefined, "never on the question");
  });

  test("an answer that is only a file is still an answer", () => {
    const s = [ask, { type: "file", file: DECK }, { type: "settled" }].reduce<typeof EMPTY_CONVERSATION>(
      (state, action) => reduce(state, action as ConversationAction),
      EMPTY_CONVERSATION,
    );
    assert.equal(s.turns.length, 2);
    assert.deepEqual(s.turns[1]!.files, [DECK]);
  });

  test("an answer fetched back after a dropped connection brings its files", () => {
    const s = [
      ask,
      { type: "delta", delta: "Here is" },
      { type: "recovering" },
      { type: "recovered", text: "Here is the deck.", files: [DECK] },
    ].reduce<typeof EMPTY_CONVERSATION>((state, action) => reduce(state, action as ConversationAction), EMPTY_CONVERSATION);
    assert.deepEqual(s.turns[1]!.files, [DECK]);
    assert.equal(s.turns[1]!.text, "Here is the deck.");
  });

  test("a stored thread keeps its files, and only real ones", () => {
    const turns = toTurns([
      { role: "user", content: "A deck", parts: [{ type: "text", text: "A deck" }] },
      {
        role: "assistant",
        content: "Here is the deck.",
        parts: [
          { type: "text", text: "Here is the deck." },
          { type: "tool-code_execution", output: { file_id: DECK.fileId } },
          { type: "file-download", ...DECK },
          { type: "file-download", fileId: "not-an-id", filename: "x.pptx" },
        ],
      },
      // Only a file, no words.
      { role: "assistant", content: "", parts: [{ type: "file-download", ...DECK, fileId: "file_second" }] },
    ]);
    assert.equal(turns.length, 3);
    assert.deepEqual(turns[1]!.files, [DECK]);
    assert.equal(turns[2]!.files?.[0]?.fileId, "file_second");
    assert.equal(turns[0]!.files, undefined);
  });

  test("a saved answer with a file counts as answered", () => {
    const stored = [
      { id: "u", role: "user" as const, text: "A deck" },
      { id: "a", role: "assistant" as const, text: "", files: [DECK] },
    ];
    assert.deepEqual(storedAnswer(stored, "A deck", 1), { kind: "answered", text: "", files: [DECK] });
  });
});

/* ── Dashboards saved as files ───────────────────────────────────────────── */

describe("a dashboard saved as a file", () => {
  test("is FO's document type, with the right extension", () => {
    assert.deepEqual(artifactFile({ type: "text/html", title: "Analytics Dashboard" }), {
      filename: "Analytics_Dashboard.html",
      mimeType: "text/html;charset=utf-8",
    });
    assert.equal(artifactFile({ type: "image/svg+xml", title: "Flow" }).filename, "Flow.svg");
    assert.equal(artifactFile({ type: "text/markdown", title: "Notes" }).filename, "Notes.md");
    assert.equal(artifactFile({ type: "application/vnd.ant.code", title: "Query" }).filename, "Query.txt");
  });

  test("its name is safe on every device", () => {
    assert.equal(safeName('Scrap / Yield: "Line 4" — Q3?'), "Scrap_Yield_Line_4_Q3");
    assert.equal(safeName("  "), "dashboard");
    assert.equal(safeName("../../etc/passwd"), "etcpasswd");
    assert.ok(safeName("x".repeat(300)).length <= 80);
  });
});

/* ── The download route ──────────────────────────────────────────────────── */

describe("downloading a file", () => {
  const FO_TOKEN = "fo-token-not-real";
  const THREAD = "7b0f6a52-3c55-4a4e-9a51-5d1f2d6c9e10";
  const PWA_TOKEN = sessionFor(
    { id: "u1", email: "supervisor@plant.example", name: "Operator", roleName: "Supervisor" },
    new Date(Date.now() + 864e5).toISOString(),
    FO_TOKEN,
  ).token;

  const realFetch = globalThis.fetch;
  let calls: string[] = [];

  const threadWith = (...fileIds: string[]) => ({
    id: THREAD,
    messages: [
      { role: "user", content: "A deck" },
      { role: "assistant", content: "Here.", parts: fileIds.map((fileId) => ({ type: "file-download", fileId })) },
    ],
  });

  function stubFo(opts: { conversation?: () => Response; file?: () => Response } = {}) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      calls.push(url.pathname);
      if (url.pathname === `/api/conversations/${THREAD}`) {
        return opts.conversation?.() ?? Response.json(threadWith(DECK.fileId));
      }
      if (url.pathname === `/api/files/${DECK.fileId}/download`) {
        return (
          opts.file?.() ??
          new Response(new Uint8Array([0x50, 0x4b, 3, 4]), {
            headers: {
              "Content-Type": DECK.mimeType,
              "Content-Disposition": `attachment; filename="${DECK.filename}"`,
              "Content-Length": "4",
            },
          })
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
  }

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const download = (fileId = DECK.fileId, query = `?c=${THREAD}`, auth = true) =>
    DOWNLOAD(
      new NextRequest(`https://pwa.test/api/faborch/files/${fileId}${query}`, {
        headers: auth
          ? { Authorization: `Bearer ${PWA_TOKEN}`, cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}` }
          : {},
      }),
      { params: Promise.resolve({ fileId }) },
    );

  test("signed out, nothing reaches FabOrchestrator", async () => {
    stubFo();
    assert.equal((await download(DECK.fileId, `?c=${THREAD}`, false)).status, 401);
    assert.deepEqual(calls, []);
  });

  test("a malformed file id or conversation id is refused before FabOrchestrator is asked", async () => {
    stubFo();
    assert.equal((await download("../../etc/passwd")).status, 400);
    assert.equal((await download(DECK.fileId, "?c=not-a-uuid")).status, 400);
    assert.equal((await download(DECK.fileId, "")).status, 400);
    assert.deepEqual(calls, []);
  });

  test("a file that is not in the caller's conversation is never fetched", async () => {
    stubFo({ conversation: () => Response.json(threadWith("file_somebody_elses")) });
    const res = await download();
    assert.equal(res.status, 404);
    assert.ok(!calls.some((path) => path.startsWith("/api/files/")), "FO's download route must not be called");
  });

  test("a conversation that is not the caller's is never searched for files", async () => {
    stubFo({ conversation: () => new Response("", { status: 403 }) });
    assert.equal((await download()).status, 404);
    assert.ok(!calls.some((path) => path.startsWith("/api/files/")));
  });

  test("the caller's own file arrives, as an attachment that cannot run as a page", async () => {
    stubFo();
    const res = await download();
    assert.equal(res.status, 200);
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x50, 0x4b, 3, 4]);
    assert.equal(res.headers.get("Content-Type"), DECK.mimeType);
    assert.match(res.headers.get("Content-Disposition") ?? "", /^attachment; filename="WIP by line\.pptx"/);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.match(res.headers.get("Content-Security-Policy") ?? "", /sandbox/);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  });

  test("a file FabOrchestrator offers inline is still served as an attachment", async () => {
    stubFo({
      file: () => new Response("<script>alert(1)</script>", {
        headers: { "Content-Type": "text/html", "Content-Disposition": "inline" },
      }),
    });
    const res = await download();
    assert.equal(res.headers.get("Content-Disposition"), "attachment");
    assert.match(res.headers.get("Content-Security-Policy") ?? "", /sandbox/);
  });

  test("an expired file says so, and what to do", async () => {
    stubFo({ file: () => new Response("", { status: 410 }) });
    const res = await download();
    assert.equal(res.status, 410);
    const body = (await res.json()) as { code: string; error: string };
    assert.equal(body.code, "file_expired");
    assert.match(body.error, /30 days/);
  });

  test("an expired FabOrchestrator session asks for sign-in and drops the cookie", async () => {
    stubFo({ file: () => new Response("", { status: 401 }) });
    const res = await download();
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, "faborch_session_expired");
    assert.match(res.headers.get("set-cookie") ?? "", new RegExp(FO_TOKEN_COOKIE));
  });

  test("the proof reads parts of every stored message", () => {
    assert.ok(conversationHasFile(threadWith("file_a", DECK.fileId).messages, DECK.fileId));
    assert.equal(conversationHasFile(threadWith("file_a").messages, DECK.fileId), false);
    assert.equal(conversationHasFile(null, DECK.fileId), false);
  });
});
