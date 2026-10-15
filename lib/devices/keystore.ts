/**
 * This device's stamp, in the browser (6 October 2026): `DEVICE-nnn` plus an
 * ECDSA P-256 private key generated here with Web Crypto, **non-extractable**,
 * and kept as the `CryptoKey` object itself in this origin's IndexedDB. The
 * private key never leaves the device, is never converted to a string, and is
 * never sent anywhere; only the public key goes to the server, once, when the
 * key is registered.
 *
 * Storage belongs to the context that made it: on an iPhone, Safari and the
 * Home Screen app keep separate IndexedDB, so a key made in one is invisible
 * to the other. Clearing site data, removing the app, or eviction deletes the
 * key, and that context then holds none.
 *
 * ── Two ways a context gets its key (9 October 2026) ────────────────────────
 *  · `enroll`: a one-time enrollment QR from an administrator. Creates a
 *    `DEVICE-nnn`; this key is its ROOT credential.
 *  · `attachFromGrant`: an app added to the Home Screen from a browser that is
 *    already enrolled. iOS copies the browser's cookies into the new app, and
 *    among them is a one-time install grant (`keepInstallGrant`, below, keeps
 *    one there). The app makes **its own** key and the grant registers it
 *    under the browser's `DEVICE-nnn`. No second QR, no second device. See
 *    `lib/devices/install-grant.ts`.
 *
 * Either way the stored record is the same shape, and a key is identified to
 * the server by its **credential id**: the fingerprint of its public key,
 * which this file computes from the public key it already stores. A record
 * written before credential ids existed needs no change.
 *
 * `extractable: false` stops export, not use: any script running on this origin
 * while the page is open can ask it to sign. The server's challenges are
 * single-use, short-lived and purpose-bound, and sign-in still needs the
 * person's password.
 *
 * Client-only.
 */

const DB_NAME = "fo-device";
const DB_VERSION = 1;
const STORE = "credential";

type RecordId = "device" | "pending";

export interface DeviceCredential {
  id: RecordId;
  deviceId: string | null;
  privateKey: CryptoKey;
  publicKeySpki: string;
  createdAt: number;
}

function b64url(bytes: ArrayBuffer): string {
  let text = "";
  for (const b of new Uint8Array(bytes)) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A key's credential id: SHA-256 of its public key (SPKI DER), first 16 bytes,
 * hex. The same value the server derives (`lib/devices/challenges.ts`,
 * `keyFingerprint`); a test holds the two together.
 */
export async function credentialIdOf(publicKeySpki: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64url(publicKeySpki)));
  let hex = "";
  for (let i = 0; i < 16; i += 1) hex += digest[i]!.toString(16).padStart(2, "0");
  return hex;
}

export function isInstalledApp(): boolean {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

/** An iPhone or iPad, including an iPad that presents itself as a Mac. */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return true;
  return /Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1;
}

/**
 * Whether an app installed from this page would get storage of its own, and so
 * need an install grant: a browser tab on an iPhone or iPad, or Safari on a
 * Mac ("Add to Dock"). Elsewhere an installed app shares its browser's
 * storage and already has the key. A convenience only: it saves requests. The
 * server decides who may have a grant.
 */
export function mayInstallSeparately(): boolean {
  if (typeof navigator === "undefined" || isInstalledApp()) return false;
  if (isIos()) return true;
  const ua = navigator.userAgent;
  return /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened"));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const request = run(t.objectStore(STORE));
        let value: T;
        request.onsuccess = () => (value = request.result);
        // Resolve on commit: "stored" must mean durable.
        t.oncomplete = () => {
          db.close();
          resolve(value);
        };
        t.onerror = () => {
          db.close();
          reject(t.error ?? request.error ?? new Error("IndexedDB transaction failed"));
        };
        t.onabort = () => {
          db.close();
          reject(t.error ?? new Error("IndexedDB transaction aborted"));
        };
      }),
  );
}

function usable(record: unknown): record is DeviceCredential {
  if (!record || typeof record !== "object") return false;
  const key = (record as Partial<DeviceCredential>).privateKey;
  return (
    typeof CryptoKey !== "undefined" &&
    key instanceof CryptoKey &&
    key.type === "private" &&
    key.extractable === false &&
    key.algorithm.name === "ECDSA" &&
    key.usages.includes("sign") &&
    typeof (record as DeviceCredential).publicKeySpki === "string"
  );
}

export type StoredDevice =
  | { kind: "enrolled"; credential: DeviceCredential & { deviceId: string } }
  | { kind: "none" }
  /** A record is there, but not a usable key (for example a platform that stored it as null). */
  | { kind: "unusable"; detail: string }
  | { kind: "storage-error"; detail: string };

/** This device's enrolled credential, if it has one. */
export async function storedDevice(): Promise<StoredDevice> {
  if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle) {
    return { kind: "storage-error", detail: "This browser has no IndexedDB or Web Crypto." };
  }
  let record: unknown;
  try {
    record = await tx("readonly", (s) => s.get("device"));
  } catch (error) {
    return { kind: "storage-error", detail: describe(error) };
  }
  if (record === undefined) return { kind: "none" };
  if (!usable(record) || !(record as DeviceCredential).deviceId) {
    return { kind: "unusable", detail: `privateKey is ${Object.prototype.toString.call((record as { privateKey?: unknown }).privateKey)}` };
  }
  return { kind: "enrolled", credential: record as DeviceCredential & { deviceId: string } };
}

async function postJson<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function sign(privateKey: CryptoKey, challenge: string): Promise<string> {
  return b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, fromB64url(challenge)));
}

export type EnrollResult =
  /** `pending`: the device was registered, and waits for an administrator to approve it (14 October 2026). */
  | { ok: true; deviceId: string; friendlyName: string | null; pending: boolean }
  | { ok: false; stage: "code" | "key" | "server" | "keep"; error: string; reason?: string };

interface StartAnswer {
  challengeId?: string;
  challenge?: string;
  error?: string;
  reason?: string;
}
interface FinishAnswer {
  device?: { deviceId: string; friendlyName: string | null; status?: string };
  error?: string;
  reason?: string;
}

/**
 * The steps every new key goes through, whichever permission registers it (an
 * enrollment code, or an install grant):
 *
 *  1. ask the server whether the permission is usable (nothing on this device
 *     changes if it is not);
 *  2. generate the key pair, private key non-extractable, and store the
 *     `CryptoKey` in IndexedDB (a platform that cannot is reported, never
 *     worked around with an exportable key);
 *  3. sign the server's challenge and send the public key;
 *  4. keep the key as this context's, with the `DEVICE-nnn` the server named.
 */
async function registerNewKey(startPath: string, completePath: string, permission: Record<string, string>): Promise<EnrollResult> {
  const start = await postJson<StartAnswer>(startPath, permission);
  if (start.status !== 200 || !start.body.challenge || !start.body.challengeId) {
    return { ok: false, stage: "code", error: start.body.error ?? `The server answered ${start.status}.`, reason: start.body.reason };
  }

  let pair: CryptoKeyPair;
  try {
    pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  } catch (error) {
    return { ok: false, stage: "key", error: `This browser could not create a device key: ${describe(error)}` };
  }
  const publicKeySpki = b64url(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pending: DeviceCredential = { id: "pending", deviceId: null, privateKey: pair.privateKey, publicKeySpki, createdAt: Date.now() };
  try {
    await tx("readwrite", (s) => s.put(pending));
    const back = await tx<unknown>("readonly", (s) => s.get("pending"));
    if (!usable(back)) throw new Error("the stored key could not be read back");
  } catch (error) {
    await tx("readwrite", (s) => s.delete("pending")).catch(() => {});
    return { ok: false, stage: "key", error: `This browser could not keep a device key: ${describe(error)}` };
  }

  const finish = await postJson<FinishAnswer>(completePath, {
    ...permission,
    challengeId: start.body.challengeId,
    publicKeySpki,
    signature: await sign(pair.privateKey, start.body.challenge),
    installedApp: isInstalledApp(),
    ...describeSelf(),
  });
  if (finish.status !== 200 || !finish.body.device) {
    await tx("readwrite", (s) => s.delete("pending")).catch(() => {});
    return { ok: false, stage: "server", error: finish.body.error ?? `The server answered ${finish.status}.`, reason: finish.body.reason };
  }

  try {
    await tx("readwrite", (s) => s.put({ ...pending, id: "device", deviceId: finish.body.device!.deviceId } satisfies DeviceCredential));
    await tx("readwrite", (s) => s.delete("pending"));
  } catch (error) {
    return { ok: false, stage: "keep", error: `Registered, but this browser could not keep the key: ${describe(error)}` };
  }
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* best effort: asks the browser not to evict this site's storage */
  }
  return {
    ok: true,
    deviceId: finish.body.device.deviceId,
    friendlyName: finish.body.device.friendlyName,
    pending: finish.body.device.status === "PENDING",
  };
}

/**
 * What the device says about itself for the administrator approving it: its
 * time zone and language. Descriptive only; the server records the address
 * and the edge region itself (`lib/devices/origin.ts`).
 */
function describeSelf(): { timeZone?: string; language?: string } {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const language = navigator.language;
    return {
      ...(timeZone ? { timeZone: timeZone.slice(0, 64) } : {}),
      ...(language ? { language: language.slice(0, 35) } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Enroll this device with a one-time enrollment code (from the in-app scanner,
 * or `undefined` to use the code the enrollment link left in a cookie). The
 * new key becomes a new `DEVICE-nnn`'s ROOT credential.
 */
export async function enroll(token: string | undefined): Promise<EnrollResult> {
  const result = await registerNewKey("/api/pwa/device-enrollments/start", "/api/pwa/device-enrollments/complete", token ? { token } : {});
  // So that an app added to the Home Screen right after enrolling finds a
  // grant. A device waiting for approval is given none until it is approved.
  if (result.ok && !result.pending) void keepInstallGrant().catch(() => {});
  return result;
}

/**
 * Join the device this app was installed from, with the install grant among
 * the cookies iOS copied into it (`lib/devices/install-grant.ts`). This
 * context makes **its own** key; the grant registers it under the browser's
 * `DEVICE-nnn`, once. `stage: "code"` means there was no usable grant: nothing
 * was created, and the caller falls back to an enrollment QR.
 */
export function attachFromGrant(): Promise<EnrollResult> {
  // One attempt at a time per page: a grant works once, and two attempts
  // racing would leave the loser reporting a failure beside the winner's key.
  attaching ??= registerNewKey("/api/pwa/device-credentials/attach/start", "/api/pwa/device-credentials/attach/complete", {}).finally(
    () => {
      attaching = null;
    },
  );
  return attaching;
}

let attaching: Promise<EnrollResult> | null = null;

/**
 * Why the server gave no challenge: it does not know the key, the device is
 * waiting for an administrator's approval, the device was revoked (or its
 * request rejected), or this key's own approval ended (removed by an
 * administrator, or replaced by a newer install of the app) while the device
 * stays approved.
 */
type Refusal = "unknown-device" | "pending" | "revoked" | "credential-ended" | "unavailable";

type ChallengeAnswer = { ok: true; challengeId: string; challenge: string } | { ok: false; reason: Refusal; detail?: string };

/** The server's sign-in challenge for one credential, or why there is none. */
async function signInChallenge(deviceId: string, credentialId: string): Promise<ChallengeAnswer> {
  const res = await postJson<{ challengeId?: string; challenge?: string; code?: string; error?: string }>("/api/pwa/device-auth/challenge", {
    deviceId,
    credentialId,
  });
  if (res.status === 404) return { ok: false, reason: "unknown-device" };
  if (res.status === 403 && res.body.code === "device_pending") return { ok: false, reason: "pending", detail: res.body.error };
  if (res.status === 403 && res.body.code === "device_revoked") return { ok: false, reason: "revoked", detail: res.body.error };
  if (res.status === 403 && res.body.code === "credential_revoked") return { ok: false, reason: "credential-ended", detail: res.body.error };
  if (res.status !== 200 || !res.body.challenge || !res.body.challengeId) return { ok: false, reason: "unavailable", detail: res.body.error };
  return { ok: true, challengeId: res.body.challengeId, challenge: res.body.challenge };
}

export type ProofResult =
  | { ok: true; proof: { deviceId: string; credentialId: string; challengeId: string; signature: string } }
  | { ok: false; reason: "not-enrolled" | Refusal; detail?: string };

/** A fresh sign-in proof: the server's challenge for this credential, signed with its stored key. */
export async function signInProof(): Promise<ProofResult> {
  const stored = await storedDevice();
  if (stored.kind !== "enrolled") return { ok: false, reason: "not-enrolled", detail: stored.kind === "none" ? undefined : stored.detail };
  const { deviceId, privateKey, publicKeySpki } = stored.credential;
  const credentialId = await credentialIdOf(publicKeySpki);
  const challenge = await signInChallenge(deviceId, credentialId);
  if (!challenge.ok) return challenge;
  return { ok: true, proof: { deviceId, credentialId, challengeId: challenge.challengeId, signature: await sign(privateKey, challenge.challenge) } };
}

/**
 * Whether the server still approves the key this browser holds.
 *
 * The key outlives a revocation (the server cannot reach into this browser to
 * delete it), so holding one says which device this is, not that it may still
 * be used. The sign-in page and `/device-blocked` ask this before they say
 * "approved". Nothing is signed: the challenge it is given simply expires.
 */
export async function deviceStatus(
  credential: Pick<DeviceCredential, "deviceId" | "publicKeySpki">,
): Promise<"approved" | "pending" | "revoked" | "credential-ended" | "unknown" | "unavailable"> {
  try {
    if (!credential.deviceId) return "unknown";
    const answer = await signInChallenge(credential.deviceId, await credentialIdOf(credential.publicKeySpki));
    if (answer.ok) return "approved";
    return answer.reason === "unknown-device" ? "unknown" : answer.reason;
  } catch {
    return "unavailable";
  }
}

/* ── Keeping an install grant ready ────────────────────────────────────────── */

/**
 * When the grant this browser last obtained runs out (ms since epoch), in
 * localStorage. Shared with `public/fo-shell.js`, which keeps the grant on
 * FabOrchestrator's own pages: whichever page is open asks, and neither asks
 * while the other's is fresh.
 */
export const INSTALL_GRANT_UNTIL_KEY = "fo_install_grant_until";

/** Ask for a new grant when the remembered one has less than this left. The server applies the same rule. */
const RENEW_BELOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The installed app currently attached to this device, as the server reported it to the device's own browser. */
export interface AttachedApp {
  credentialId: string;
  addedAt: string;
}

export type KeepGrantResult =
  /** Nothing to do here: not a context an app is installed from, no key, or the grant held is fresh. */
  | { kind: "skipped" }
  | { kind: "kept"; app: AttachedApp | null }
  | { kind: "refused" | "unavailable" };

function rememberedGrantUntil(): number {
  try {
    return Number(window.localStorage.getItem(INSTALL_GRANT_UNTIL_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Make sure this browser holds a fresh install grant, so that if the person
 * adds the app to the Home Screen now, the cookies iOS copies into it include
 * one. Proves this context's key to the server (a signed `grant` challenge);
 * the server gives a grant only to the key the device was enrolled with, in an
 * httpOnly cookie this code never sees.
 *
 * Cheap to call often: it does nothing unless this is a context an app is
 * installed from, a key is stored, and the last grant is close to running out.
 *
 * `force` asks the server even when the grant remembered here looks fresh. A
 * grant is spent when an app attaches with it, and this browser is not told;
 * so a page that returns to the foreground asks again, and the server answers
 * with a new grant if the last one was used (and keeps it if it was not). That
 * is what lets somebody remove the app and add it again a minute later.
 */
export async function keepInstallGrant(options: { force?: boolean } = {}): Promise<KeepGrantResult> {
  if (!mayInstallSeparately()) return { kind: "skipped" };
  if (!options.force && rememberedGrantUntil() - Date.now() > RENEW_BELOW_MS) return { kind: "skipped" };
  const stored = await storedDevice();
  if (stored.kind !== "enrolled") return { kind: "skipped" };
  const { deviceId, privateKey, publicKeySpki } = stored.credential;
  const credentialId = await credentialIdOf(publicKeySpki);

  const challenge = await postJson<{ challengeId?: string; challenge?: string }>("/api/pwa/device-auth/challenge", {
    deviceId,
    credentialId,
    purpose: "grant",
  });
  if (challenge.status === 403 || challenge.status === 404) return { kind: "refused" };
  if (challenge.status !== 200 || !challenge.body.challenge || !challenge.body.challengeId) return { kind: "unavailable" };

  const grant = await postJson<{ ok?: boolean; expiresAt?: string; app?: AttachedApp | null }>("/api/pwa/device-credentials/grant", {
    deviceId,
    credentialId,
    challengeId: challenge.body.challengeId,
    signature: await sign(privateKey, challenge.body.challenge),
  });
  if (grant.status === 403 || grant.status === 404) return { kind: "refused" };
  if (grant.status !== 200 || !grant.body.expiresAt) return { kind: "unavailable" };
  try {
    window.localStorage.setItem(INSTALL_GRANT_UNTIL_KEY, String(new Date(grant.body.expiresAt).getTime()));
  } catch {
    /* Without it the next page asks again, and the server keeps the grant that is still fresh. */
  }
  return { kind: "kept", app: grant.body.app ?? null };
}

/** Forget this device's key (it becomes unenrolled). */
export async function forgetDevice(): Promise<void> {
  await tx("readwrite", (s) => s.delete("device"));
}

function describe(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
