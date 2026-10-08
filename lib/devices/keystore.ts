/**
 * This device's stamp, in the browser (6 October 2026): `DEVICE-nnn` plus an
 * ECDSA P-256 private key generated here with Web Crypto, **non-extractable**,
 * and kept as the `CryptoKey` object itself in this origin's IndexedDB. The
 * private key never leaves the device, is never converted to a string, and is
 * never sent anywhere; only the public key goes to the server, once, at
 * enrollment.
 *
 * Storage belongs to the context that made it: on an iPhone, Safari and the
 * Home Screen app keep separate IndexedDB, so a key made in one is invisible
 * to the other. Clearing site data, removing the app, or eviction deletes the
 * key, and the device is then unenrolled: it needs a new enrollment QR.
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

export function isIos(): boolean {
  return typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
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
  | { ok: true; deviceId: string; friendlyName: string | null }
  | { ok: false; stage: "code" | "key" | "server" | "keep"; error: string; reason?: string };

/**
 * Enroll this device with a one-time enrollment code (from the in-app scanner,
 * or `undefined` to use the code the enrollment link left in a cookie):
 *
 *  1. ask the server whether the code is usable (nothing on this device
 *     changes if it is not);
 *  2. generate the key pair, private key non-extractable, and store the
 *     `CryptoKey` in IndexedDB (a platform that cannot is reported, never
 *     worked around with an exportable key);
 *  3. sign the server's challenge and send the public key;
 *  4. keep the key as this device's, with the `DEVICE-nnn` the server gave it.
 */
export async function enroll(token: string | undefined): Promise<EnrollResult> {
  const start = await postJson<{ challengeId?: string; challenge?: string; error?: string; reason?: string }>(
    "/api/pwa/device-enrollments/start",
    token ? { token } : {},
  );
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

  const finish = await postJson<{ device?: { deviceId: string; friendlyName: string | null }; error?: string; reason?: string }>(
    "/api/pwa/device-enrollments/complete",
    {
      ...(token ? { token } : {}),
      challengeId: start.body.challengeId,
      publicKeySpki,
      signature: await sign(pair.privateKey, start.body.challenge),
      installedApp: isInstalledApp(),
    },
  );
  if (finish.status !== 200 || !finish.body.device) {
    await tx("readwrite", (s) => s.delete("pending")).catch(() => {});
    return { ok: false, stage: "server", error: finish.body.error ?? `The server answered ${finish.status}.`, reason: finish.body.reason };
  }

  try {
    await tx("readwrite", (s) => s.put({ ...pending, id: "device", deviceId: finish.body.device!.deviceId } satisfies DeviceCredential));
    await tx("readwrite", (s) => s.delete("pending"));
  } catch (error) {
    return { ok: false, stage: "keep", error: `Enrolled, but this browser could not keep the key: ${describe(error)}` };
  }
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* best effort: asks the browser not to evict this site's storage */
  }
  return { ok: true, deviceId: finish.body.device.deviceId, friendlyName: finish.body.device.friendlyName };
}

type ChallengeAnswer =
  | { ok: true; challengeId: string; challenge: string }
  | { ok: false; reason: "unknown-device" | "revoked" | "unavailable"; detail?: string };

/** The server's sign-in challenge for a device, or why there is none (refused for a revoked device). */
async function signInChallenge(deviceId: string): Promise<ChallengeAnswer> {
  const res = await postJson<{ challengeId?: string; challenge?: string; code?: string; error?: string }>("/api/pwa/device-auth/challenge", { deviceId });
  if (res.status === 404) return { ok: false, reason: "unknown-device" };
  if (res.status === 403 && res.body.code === "device_revoked") return { ok: false, reason: "revoked", detail: res.body.error };
  if (res.status !== 200 || !res.body.challenge || !res.body.challengeId) return { ok: false, reason: "unavailable", detail: res.body.error };
  return { ok: true, challengeId: res.body.challengeId, challenge: res.body.challenge };
}

export type ProofResult =
  | { ok: true; proof: { deviceId: string; challengeId: string; signature: string } }
  | { ok: false; reason: "not-enrolled" | "unknown-device" | "revoked" | "unavailable"; detail?: string };

/** A fresh sign-in proof: the server's challenge for this device, signed with its stored key. */
export async function signInProof(): Promise<ProofResult> {
  const stored = await storedDevice();
  if (stored.kind !== "enrolled") return { ok: false, reason: "not-enrolled", detail: stored.kind === "none" ? undefined : stored.detail };
  const { deviceId, privateKey } = stored.credential;
  const challenge = await signInChallenge(deviceId);
  if (!challenge.ok) return challenge;
  return { ok: true, proof: { deviceId, challengeId: challenge.challengeId, signature: await sign(privateKey, challenge.challenge) } };
}

/**
 * Whether the server still approves the device whose key this browser holds.
 *
 * The key outlives a revocation (the server cannot reach into this browser to
 * delete it), so holding one says which device this is, not that it may still
 * be used. The sign-in page and `/device-blocked` ask this before they say
 * "approved". Nothing is signed: the challenge it is given simply expires.
 */
export async function deviceStatus(deviceId: string): Promise<"approved" | "revoked" | "unknown" | "unavailable"> {
  try {
    const answer = await signInChallenge(deviceId);
    if (answer.ok) return "approved";
    return answer.reason === "unknown-device" ? "unknown" : answer.reason;
  } catch {
    return "unavailable";
  }
}

/** Forget this device's key (it becomes unenrolled). */
export async function forgetDevice(): Promise<void> {
  await tx("readwrite", (s) => s.delete("device"));
}

function describe(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
