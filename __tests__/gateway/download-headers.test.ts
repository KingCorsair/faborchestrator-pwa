/**
 * Generated-file download hardening at the gateway (`hardenFoApiHeaders`),
 * the embedded equivalent of the chetan branch's download route (`3d4fc1a`):
 * a file FabOrchestrator's model made is always a download and never a page on
 * this origin, and every API answer carries `nosniff`.
 *
 * Who may download which file is deliberately NOT tested here: that ownership
 * decision (FO fix or gateway proof) is still open.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SIGNING_SECRET ??= "test-secret-that-is-long-enough-to-sign";
process.env.SESSION_SIGNING_KEY_ID ??= "test-key";
process.env.FABORCH_BASE_URL = "https://fo.test";
process.env.FO_EMBED_MODE = "whole";

import { NextRequest } from "next/server";
import { sessionFor } from "@/lib/auth";
import { FO_TOKEN_COOKIE } from "@/lib/faborch/session";
import { hardenFoApiHeaders, isFileDownload } from "@/lib/gateway/headers";
import { GATEWAY_MARKER_HEADER } from "@/lib/gateway/registry";
import { GET } from "@/app/fo-gateway/[...path]/route";

const DOWNLOAD = "/api/files/file_011CUabcdefghijklmn/download";

describe("the header rule", () => {
  const harden = (path: string, init: Record<string, string>) => {
    const h = new Headers(init);
    hardenFoApiHeaders(path, h);
    return h;
  };

  test("only a generated file's download path counts as a download", () => {
    assert.equal(isFileDownload(DOWNLOAD), true);
    assert.equal(isFileDownload("/api/files/file_011CUabcdefghijklmn"), false, "metadata is JSON");
    assert.equal(isFileDownload("/api/files/a/download/x"), false);
  });

  test("an attachment keeps its filename", () => {
    const h = harden(DOWNLOAD, { "content-disposition": 'attachment; filename="yield.pptx"' });
    assert.equal(h.get("content-disposition"), 'attachment; filename="yield.pptx"');
  });

  test("inline becomes an attachment, filename kept", () => {
    const h = harden(DOWNLOAD, { "content-disposition": 'inline; filename="report.html"' });
    assert.equal(h.get("content-disposition"), 'attachment; filename="report.html"');
  });

  test("no disposition at all becomes an attachment", () => {
    assert.equal(harden(DOWNLOAD, {}).get("content-disposition"), "attachment");
  });

  test("a download can never run script as this origin", () => {
    const h = harden(DOWNLOAD, { "content-type": "text/html" });
    assert.equal(h.get("content-security-policy"), "sandbox");
    assert.equal(h.get("x-content-type-options"), "nosniff");
  });

  test("any other API answer gets nosniff and nothing else", () => {
    const h = harden("/api/conversations", { "content-type": "application/json" });
    assert.equal(h.get("x-content-type-options"), "nosniff");
    assert.equal(h.get("content-disposition"), null);
    assert.equal(h.get("content-security-policy"), null);
  });
});

describe("through the gateway route", () => {
  const FO_TOKEN = "fo-session-not-a-real-token";
  const PWA_TOKEN = sessionFor(
    { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" },
    new Date(Date.now() + 864e5).toISOString(),
    FO_TOKEN,
  ).token;
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const viaGateway = (path: string, answer: Response) => {
    globalThis.fetch = (async () => answer) as typeof fetch;
    return GET(
      new NextRequest(new URL(`/fo-gateway${path}`, "https://pwa.test"), {
        headers: {
          [GATEWAY_MARKER_HEADER]: "1",
          authorization: `Bearer ${PWA_TOKEN}`,
          cookie: `${FO_TOKEN_COOKIE}=${FO_TOKEN}`,
        },
      }),
      { params: Promise.resolve({ path: path.slice(1).split("/") }) },
    );
  };

  test("a generated HTML file FO offers inline arrives as a sandboxed attachment", async () => {
    const res = await viaGateway(
      DOWNLOAD,
      new Response("<script>steal()</script>", {
        headers: { "content-type": "text/html", "content-disposition": 'inline; filename="dash.html"' },
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="dash.html"');
    assert.equal(res.headers.get("content-security-policy"), "sandbox");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  test("file metadata is JSON with nosniff, not forced to a download", async () => {
    const res = await viaGateway(
      "/api/files/file_011CUabcdefghijklmn",
      Response.json({ id: "file_011CUabcdefghijklmn", filename: "yield.pptx" }),
    );
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("content-disposition"), null);
  });

  test("FabOrchestrator's own pages are left alone", async () => {
    const res = await viaGateway("/chat", new Response("<html><head></head><body></body></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    assert.equal(res.headers.get("x-content-type-options"), null);
    assert.equal(res.headers.get("content-security-policy"), null);
    await res.text();
  });
});
