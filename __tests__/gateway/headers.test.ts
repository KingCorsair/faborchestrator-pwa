/**
 * Header policy for the gateway (`lib/gateway/headers.ts`).
 *
 * Both directions are allow-lists; these tests hold the lines that matter
 * for security (cookies and authorization never go up; load-balancer cookies
 * never come down) and for phones (FO's year-long HTML cache is overridden;
 * streams stay unbuffered).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { downstreamResponseHeaders, rewriteLocation, upstreamRequestHeaders } from "@/lib/gateway/headers";

const FO = "https://d7y8a8whrch88.cloudfront.net";

describe("upstream request headers", () => {
  const incoming = new Headers({
    accept: "text/html",
    "accept-language": "en",
    cookie: "faborch_token=secret; llmatscale=x",
    authorization: "Bearer pwa-session",
    host: "faborch-demo.fly.dev",
    "user-agent": "iPhone",
    rsc: "1",
    "next-router-state-tree": "%5B%22%22%5D",
    "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    connection: "keep-alive",
    "content-type": "application/json",
    "content-length": "999999",
  });
  const out = upstreamRequestHeaders(incoming, { ip: "203.0.113.9", proto: "https" });

  test("the session cookie never leaves this app", () => {
    assert.equal(out.get("cookie"), null);
  });
  test("authorization is dropped in WP1 (WP2 injects the FO token instead)", () => {
    assert.equal(out.get("authorization"), null);
  });
  test("host and hop-by-hop headers are not forwarded", () => {
    assert.equal(out.get("host"), null);
    assert.equal(out.get("connection"), null);
  });
  test("negotiation, router and user-agent headers are forwarded", () => {
    assert.equal(out.get("accept"), "text/html");
    assert.equal(out.get("accept-language"), "en");
    assert.equal(out.get("rsc"), "1");
    assert.equal(out.get("next-router-state-tree"), "%5B%22%22%5D");
    assert.equal(out.get("user-agent"), "iPhone");
    assert.equal(out.get("content-type"), "application/json");
  });
  test("the phone's address and scheme reach FO's audit", () => {
    assert.equal(out.get("x-forwarded-for"), "203.0.113.9");
    assert.equal(out.get("x-forwarded-proto"), "https");
  });
  test("the phone's own content-length is never forwarded (plan RP1 part 3)", () => {
    // The gateway sets it from the bytes it actually read; forwarding the
    // phone's claim is what made a cut-off body a length-mismatch 502 (G2).
    assert.equal(out.get("content-length"), null);
  });
});

describe("downstream response headers", () => {
  test("FO's HTML cache header is overridden and the ALB cookies are dropped", () => {
    const up = new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "s-maxage=31536000",
      etag: '"abc"',
      vary: "Accept-Encoding",
      "set-cookie": "AWSALB=x; Path=/",
      "content-encoding": "gzip",
      "content-length": "12345",
      server: "nginx/1.28.2",
      via: "1.1 cloudfront",
    });
    const out = downstreamResponseHeaders(up, FO);
    assert.equal(out.get("cache-control"), "no-cache, must-revalidate");
    assert.equal(out.get("etag"), '"abc"');
    assert.equal(out.get("vary"), "Accept-Encoding");
    assert.equal(out.get("set-cookie"), null);
    assert.equal(out.get("content-encoding"), null);
    assert.equal(out.get("content-length"), null);
    assert.equal(out.get("server"), null);
    assert.equal(out.get("via"), null);
  });

  test("an RSC payload is treated as a document", () => {
    const out = downstreamResponseHeaders(new Headers({ "content-type": "text/x-component", "cache-control": "s-maxage=31536000" }), FO);
    assert.equal(out.get("cache-control"), "no-cache, must-revalidate");
  });

  test("an immutable chunk keeps its cache header", () => {
    const out = downstreamResponseHeaders(
      new Headers({ "content-type": "application/javascript", "cache-control": "public, max-age=31536000, immutable" }),
      FO,
    );
    assert.equal(out.get("cache-control"), "public, max-age=31536000, immutable");
  });

  test("a stream keeps no-transform and is marked unbufferable", () => {
    const out = downstreamResponseHeaders(new Headers({ "content-type": "text/event-stream" }), FO);
    assert.equal(out.get("cache-control"), "no-cache, no-transform");
    assert.equal(out.get("x-accel-buffering"), "no");
  });

  test("a Location on the FO origin is rewritten onto this origin", () => {
    const out = downstreamResponseHeaders(new Headers({ location: `${FO}/chat?x=1` }), FO);
    assert.equal(out.get("location"), "/chat?x=1");
  });
});

describe("rewriteLocation", () => {
  test("FO origin root becomes /", () => assert.equal(rewriteLocation(FO, FO), "/"));
  test("FO origin path becomes the path", () => assert.equal(rewriteLocation(`${FO}/reports`, FO), "/reports"));
  test("a relative location passes through", () => assert.equal(rewriteLocation("/home", FO), "/home"));
  test("another host passes through untouched", () => assert.equal(rewriteLocation("https://example.com/x", FO), "https://example.com/x"));
  test("a host that merely starts with the origin is not rewritten", () =>
    assert.equal(rewriteLocation(`${FO}.evil.example/x`, FO), `${FO}.evil.example/x`));
});

describe("redirects from either FabOrchestrator origin stay on this app (RP1, G17)", () => {
  const UI = "http://faborch-fo-ui-preview.internal:3000";
  test("a Location naming the other origin is rewritten too", () => {
    assert.equal(rewriteLocation(`${UI}/chat`, [FO, UI]), "/chat");
    assert.equal(rewriteLocation(`${FO}/home`, [FO, UI]), "/home");
    assert.equal(rewriteLocation("https://example.com/x", [FO, UI]), "https://example.com/x");
  });
  test("the response headers use every origin given", () => {
    const out = downstreamResponseHeaders(new Headers({ location: `${UI}/force-password-change` }), [FO, UI]);
    assert.equal(out.get("location"), "/force-password-change");
  });
});
