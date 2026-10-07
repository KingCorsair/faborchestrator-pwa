/**
 * `scripts/device-enrollment.mjs` writes the store's record format without
 * importing it (the production image has no TypeScript runner). These tests
 * hold the two together: what the CLI writes, the store reads as a valid,
 * usable enrollment, and the raw token is printed once and never stored.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentStorePath, setUp, tearDown } from "./fixture";
import { describeDevice } from "@/lib/devices/metadata";
import { DeviceStore, parseRecord } from "@/lib/devices/store";

const CLI = join(process.cwd(), "scripts", "device-enrollment.mjs");

beforeEach(() => setUp());
afterEach(() => tearDown());

function run(...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, PUBLIC_ORIGIN: "" } });
}

test("the CLI's enrollment is one the store accepts and can complete", async () => {
  const out = run("--store", currentStorePath(), "--origin", "https://pwa.test", "--minutes", "5", "--name", "Desk PC");
  const url = /https:\/\/pwa\.test\/device-enroll\/([A-Za-z0-9_-]{43})/.exec(out);
  assert.ok(url, out);
  const token = url[1]!;

  const lines = readFileSync(currentStorePath(), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.ok(parseRecord(lines[0]!), "the CLI's line must verify under the store's checksum");
  assert.ok(!lines[0]!.includes(token), "the token is printed, never stored");

  const store = new DeviceStore(currentStorePath());
  try {
    const lookup = await store.lookupEnrollment(token);
    assert.equal(lookup.kind, "valid");
    if (lookup.kind !== "valid") return;
    assert.equal(lookup.enrollment.createdBy, "bootstrap-cli");
    assert.ok(lookup.enrollment.expiresAt - lookup.enrollment.createdAt === 5 * 60 * 1000);

    const done = await store.completeEnrollment({ token, metadata: describeDevice(null, false) });
    assert.equal(done.kind, "enrolled");
    if (done.kind === "enrolled") assert.equal(done.device.friendlyName, "Desk PC");
  } finally {
    await store.close();
  }
});

test("the CLI refuses to run without what it needs", () => {
  assert.throws(() => run("--origin", "https://pwa.test", "--store", ""));
  assert.throws(() => run("--store", currentStorePath()));
  assert.throws(() => run("--store", currentStorePath(), "--origin", "https://pwa.test", "--minutes", "90"));
  assert.throws(() => run("--email", "a@b.c", "--store", currentStorePath(), "--origin", "https://pwa.test"));
});
