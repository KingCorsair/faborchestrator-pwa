#!/usr/bin/env node
/**
 * Issue a one-time device enrollment from a shell on the server: the bootstrap
 * for the first administrator's device, and the way in if every administrator
 * has lost theirs (`lib/devices/`).
 *
 * The administration screen needs an approved device, so the first approved
 * device cannot come from it. Whoever can run this already has a shell on the
 * machine (and so could read or write the store anyway); no network endpoint
 * gives the same power.
 *
 *   node scripts/device-enrollment.mjs --email someone@plant.example \
 *     [--store /data/devices/devices.log] [--origin https://app.example] \
 *     [--minutes 10] [--name "Line 3 phone"] [--site "Fab 2"]
 *
 * On the Fly machine:
 *   flyctl ssh console --app <app> -C \
 *     "su-exec nextjs:nodejs node scripts/device-enrollment.mjs --email someone@plant.example"
 *
 * `--store` and `--origin` default to DEVICE_STORE_PATH and PUBLIC_ORIGIN. It
 * prints the enrollment link once, to this terminal; the store keeps only the
 * token's hash. Open the link on the device to enroll, within the lifetime.
 *
 * Plain JavaScript with no imports from the app, because the production image
 * has no TypeScript runner. The record format is `lib/devices/store.ts`'s,
 * and `__tests__/devices/bootstrap-cli.test.ts` holds the two together.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) fail(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`${key} needs a value`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

/** `lib/devices/store.ts` `recordChecksum`. */
function checksum(fields) {
  const canonical = Object.keys(fields)
    .filter((key) => key !== "h")
    .sort()
    .map((key) => [key, fields[key]]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

const opts = args(process.argv.slice(2));
const email = (opts.email ?? "").trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail("--email must be the user's FabOrchestrator email");
const store = (opts.store ?? process.env.DEVICE_STORE_PATH ?? "").trim();
if (!store) fail("--store or DEVICE_STORE_PATH is required");
let origin;
try {
  origin = new URL((opts.origin ?? process.env.PUBLIC_ORIGIN ?? "").trim()).origin;
} catch {
  fail("--origin or PUBLIC_ORIGIN must be this app's public origin, e.g. https://app.example");
}
const minutes = Number(opts.minutes ?? process.env.DEVICE_ENROLLMENT_TTL_MINUTES ?? 10);
if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) fail("--minutes must be a whole number from 1 to 60");
const name = opts.name?.trim().slice(0, 100) || null;
const site = opts.site?.trim().slice(0, 100) || null;

const token = randomBytes(32).toString("base64url");
const now = Date.now();
const record = {
  v: 1,
  t: "enrollment",
  id: `enr_${randomBytes(32).toString("base64url").slice(0, 16)}`,
  th: createHash("sha256").update(token).digest("base64url"),
  email,
  by: "bootstrap-cli",
  site,
  name,
  at: now,
  exp: now + minutes * 60 * 1000,
};
record.h = checksum(record);

await mkdir(dirname(store), { recursive: true, mode: 0o700 });
const handle = await open(store, "a", 0o600);
try {
  // A leading newline would be harmless (blank lines carry nothing); a torn
  // previous line must not swallow this record, so always start a fresh line.
  await handle.appendFile(`\n${JSON.stringify(record)}\n`, "utf8");
  await handle.sync();
} finally {
  await handle.close();
}

console.log(`\n  Enrollment ${record.id} for ${email}, valid ${minutes} minute(s), until ${new Date(record.exp).toISOString()}.`);
console.log(`  Open this link on the device to enroll. It works once:\n\n  ${origin}/device-enroll/${token}\n`);
