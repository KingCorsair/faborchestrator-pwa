/**
 * Signing keys with explicit ids (plan RP2 part 5, finding m2).
 *
 * One secret with no id meant rotating it signed everybody out. Every token now
 * names its key (`kid`, a public label), and verification looks the id up among
 * the current key and any previous keys kept for one transition period. These
 * pin the plan's finding-map test: a token signed under a previous id verifies;
 * an unknown id fails; a short secret fails; a wrong audience fails; rotating
 * signs nobody out, and removing the previous key does.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  foFingerprint,
  inspectToken,
  MIN_SECRET_LENGTH,
  SessionConfigError,
  sessionFor,
  sessionKeyRing,
  SESSION_AUDIENCE,
  SESSION_ISSUER,
  verifyToken,
} from "@/lib/auth";

const SECRET_A = "a".repeat(40);
const SECRET_B = "b".repeat(40);
const USER = { id: "u1", email: "op@plant.example", name: "Op", roleName: "Business User" };
const IN_A_DAY = () => new Date(Date.now() + 864e5).toISOString();

const saved = { ...process.env };
function useKeys(env: { id?: string; secret?: string; previous?: string }) {
  if (env.id === undefined) delete process.env.SESSION_SIGNING_KEY_ID;
  else process.env.SESSION_SIGNING_KEY_ID = env.id;
  if (env.secret === undefined) delete process.env.SESSION_SIGNING_SECRET;
  else process.env.SESSION_SIGNING_SECRET = env.secret;
  if (env.previous === undefined) delete process.env.SESSION_SIGNING_PREVIOUS_KEYS;
  else process.env.SESSION_SIGNING_PREVIOUS_KEYS = env.previous;
}

/** A token built by hand, for shapes `sessionFor` never mints. */
function forge(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

const payloadOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;

beforeEach(() => useKeys({ id: "2026-09", secret: SECRET_A }));
afterEach(() => {
  for (const key of ["SESSION_SIGNING_KEY_ID", "SESSION_SIGNING_SECRET", "SESSION_SIGNING_PREVIOUS_KEYS"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("what a new token carries", () => {
  test("the key id, and iat, iss and aud", () => {
    const before = Date.now();
    const payload = payloadOf(sessionFor(USER, IN_A_DAY(), "fo-token").token);
    assert.equal(payload.kid, "2026-09");
    assert.equal(payload.iss, SESSION_ISSUER);
    assert.equal(payload.aud, SESSION_AUDIENCE);
    assert.ok(typeof payload.iat === "number" && payload.iat >= before);
  });

  test("the key id is the configured label, never anything taken from the secret", () => {
    const payload = payloadOf(sessionFor(USER, IN_A_DAY(), "fo-token").token);
    assert.ok(!JSON.stringify(payload).includes(SECRET_A.slice(0, 8)));
  });
});

describe("rotation (the plan's sequence)", () => {
  test("rotating signs nobody out; removing the previous key does", () => {
    const minted = sessionFor(USER, IN_A_DAY(), "fo-token").token;
    assert.ok(verifyToken(minted), "valid under the key that signed it");

    // Rotate: a new current key, the old one kept as previous.
    useKeys({ id: "2026-10", secret: SECRET_B, previous: `2026-09:${SECRET_A}` });
    assert.ok(verifyToken(minted), "a token signed under a previous id still verifies");
    assert.equal(payloadOf(sessionFor(USER, IN_A_DAY(), "fo-token").token).kid, "2026-10");

    // One TTL later the previous key is removed.
    useKeys({ id: "2026-10", secret: SECRET_B });
    assert.equal(verifyToken(minted), null, "an unknown key id fails");
  });

  test("an unknown key id fails, even when signed with a known secret", () => {
    const token = forge(
      { ...USER, exp: Date.now() + 60_000, fp: foFingerprint("t"), iat: Date.now(), iss: SESSION_ISSUER, aud: SESSION_AUDIENCE, kid: "not-a-key" },
      SECRET_A,
    );
    assert.equal(verifyToken(token), null);
  });
});

describe("claims", () => {
  const claims = () => ({ ...USER, exp: Date.now() + 60_000, fp: foFingerprint("t"), iat: Date.now(), kid: "2026-09" });

  test("a wrong audience or issuer fails", () => {
    assert.equal(verifyToken(forge({ ...claims(), iss: SESSION_ISSUER, aud: "somebody-else" }, SECRET_A)), null);
    assert.equal(verifyToken(forge({ ...claims(), iss: "somebody-else", aud: SESSION_AUDIENCE }, SECRET_A)), null);
    assert.ok(verifyToken(forge({ ...claims(), iss: SESSION_ISSUER, aud: SESSION_AUDIENCE }, SECRET_A)));
  });

  test("a token with a key id must carry every claim", () => {
    const { iat: _iat, ...noIat } = { ...claims(), iss: SESSION_ISSUER, aud: SESSION_AUDIENCE };
    assert.equal(verifyToken(forge(noIat, SECRET_A)), null);
  });

  test("expired is told apart from invalid (the gateway acts on the difference)", () => {
    const expired = forge({ ...claims(), exp: Date.now() - 1, iss: SESSION_ISSUER, aud: SESSION_AUDIENCE }, SECRET_A);
    assert.equal(inspectToken(expired).kind, "expired");
    assert.equal(inspectToken(expired.replace(/.$/, (c) => (c === "A" ? "B" : "A"))).kind, "invalid");
    assert.equal(inspectToken("nonsense").kind, "invalid");
    assert.equal(inspectToken("a.b.c").kind, "invalid");
  });
});

describe("tokens minted before the key ring (the compatibility window)", () => {
  const legacy = (secret: string) =>
    forge({ ...USER, exp: Date.now() + 60_000, fp: foFingerprint("fo-token") }, secret);

  test("a token with no key id, signed with the current secret, still verifies", () => {
    // Minted by the previous release with the same secret. It expires within
    // one TTL, so the window closes by itself.
    assert.ok(verifyToken(legacy(SECRET_A)));
  });

  test("but not one signed with any other secret", () => {
    assert.equal(verifyToken(legacy(SECRET_B)), null);
  });
});

describe("configuration is refused, never guessed at", () => {
  test(`a secret shorter than ${MIN_SECRET_LENGTH} characters`, () => {
    assert.throws(() => sessionKeyRing({ SESSION_SIGNING_KEY_ID: "2026-09", SESSION_SIGNING_SECRET: "x".repeat(31) }), SessionConfigError);
    // The old minimum of 16 is no longer enough.
    assert.throws(() => sessionKeyRing({ SESSION_SIGNING_KEY_ID: "2026-09", SESSION_SIGNING_SECRET: "x".repeat(16) }), SessionConfigError);
  });

  test("a missing or malformed key id", () => {
    assert.throws(() => sessionKeyRing({ SESSION_SIGNING_SECRET: SECRET_A }), SessionConfigError);
    assert.throws(() => sessionKeyRing({ SESSION_SIGNING_KEY_ID: "has spaces", SESSION_SIGNING_SECRET: SECRET_A }), SessionConfigError);
  });

  test("a malformed or duplicated previous key", () => {
    const base = { SESSION_SIGNING_KEY_ID: "2026-10", SESSION_SIGNING_SECRET: SECRET_B };
    assert.throws(() => sessionKeyRing({ ...base, SESSION_SIGNING_PREVIOUS_KEYS: "no-colon" }), SessionConfigError);
    assert.throws(() => sessionKeyRing({ ...base, SESSION_SIGNING_PREVIOUS_KEYS: "2026-09:short" }), SessionConfigError);
    assert.throws(() => sessionKeyRing({ ...base, SESSION_SIGNING_PREVIOUS_KEYS: `2026-10:${SECRET_A}` }), SessionConfigError);
    assert.equal(sessionKeyRing({ ...base, SESSION_SIGNING_PREVIOUS_KEYS: ` 2026-09:${SECRET_A} , ` }).byId.size, 2);
  });

  test("minting without a key id throws rather than signing with a guess", () => {
    useKeys({ secret: SECRET_A });
    assert.throws(() => sessionFor(USER, IN_A_DAY(), "fo-token"), SessionConfigError);
  });
});
