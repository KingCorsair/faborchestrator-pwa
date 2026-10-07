/**
 * Device-credential feasibility test: the browser half (6 October 2026).
 *
 * The candidate device stamp for Jothi's Option 2: an ECDSA P-256 key pair made
 * with Web Crypto, the private key **non-extractable**, and the `CryptoKey`
 * object itself stored in this PWA's IndexedDB by structured clone. Nothing
 * here converts the private key to a string. The one call that tries to export
 * it (`exportRefused`) exists to prove the browser refuses.
 *
 * Three records, so the debug buttons can never disturb an enrolled device:
 *
 *   "device"   the enrolled device: its key and its DEVICE-nnn
 *   "pending"  a key made during an enrollment, until the server confirms it
 *   "debug"    the manual debug buttons' key
 *
 * If a browser cannot persist the `CryptoKey` (WebKit refuses in private
 * browsing, with `DataCloneError`), that is reported as the result. There is no
 * fallback to an exportable or wrapped key: that would be a weaker design, and
 * the point of the test is to find out whether the strong one works.
 *
 * Client-only. Its own database, separate from anything else in the app.
 */

const DB_NAME = "fo-device-crypto-test";
const DB_VERSION = 1;
const KEYS = "keys";
const LAUNCHES = "launches";

export type RecordId = "device" | "pending" | "debug";

export interface StoredCredential {
  id: RecordId;
  privateKey: CryptoKey;
  /** Public key, SPKI DER, base64url. Public: safe to show, send and store. */
  publicKeySpki: string;
  fingerprint: string;
  createdAt: number;
  /** The context it was created in, for the report. */
  createdIn: "installed-app" | "browser";
  /** The server's id for this device, once enrolled. */
  deviceId: string | null;
}

export interface LaunchEntry {
  at: number;
  context: "installed-app" | "browser";
  /** What this page load found in IndexedDB for the enrolled device. */
  found: "usable-key" | "no-key" | "unusable-record" | "storage-error";
  deviceId?: string | null;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const b of view) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function context(): "installed-app" | "browser" {
  try {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return standalone ? "installed-app" : "browser";
  } catch {
    return "browser";
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(LAUNCHES)) db.createObjectStore(LAUNCHES, { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened"));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const request = run(t.objectStore(store));
        let value: T;
        request.onsuccess = () => (value = request.result);
        // Resolve on commit, not on request success: "stored" must mean durable.
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

export async function fingerprintOf(spkiDer: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", spkiDer));
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A record is usable only if it really holds a non-extractable ECDSA P-256 signing key. */
function usable(record: unknown): record is StoredCredential {
  if (!record || typeof record !== "object") return false;
  const r = record as Partial<StoredCredential>;
  const key = r.privateKey;
  return (
    typeof CryptoKey !== "undefined" &&
    key instanceof CryptoKey &&
    key.type === "private" &&
    key.extractable === false &&
    key.algorithm.name === "ECDSA" &&
    (key.algorithm as EcKeyAlgorithm).namedCurve === "P-256" &&
    key.usages.includes("sign") &&
    typeof r.publicKeySpki === "string" &&
    typeof r.fingerprint === "string"
  );
}

export type StoreResult =
  | { ok: true; credential: StoredCredential }
  | { ok: false; stage: "generate" | "store" | "read-back"; error: string };

/**
 * Make a new key pair (private key non-extractable) and store the private
 * `CryptoKey` itself under `id`, then read it back. Replaces that record only.
 */
export async function generateAndStore(id: RecordId, deviceId: string | null = null): Promise<StoreResult> {
  let pair: CryptoKeyPair;
  try {
    pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  } catch (error) {
    return { ok: false, stage: "generate", error: describe(error) };
  }
  // Public keys are always exportable; that is what a server stores.
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const credential: StoredCredential = {
    id,
    privateKey: pair.privateKey,
    publicKeySpki: b64url(spki),
    fingerprint: await fingerprintOf(spki),
    createdAt: Date.now(),
    createdIn: context(),
    deviceId,
  };
  return put(credential);
}

/** Store a credential record (the CryptoKey by structured clone) and read it back. */
export async function put(credential: StoredCredential): Promise<StoreResult> {
  try {
    await tx(KEYS, "readwrite", (s) => s.put(credential));
  } catch (error) {
    // DataCloneError here means: this browser cannot persist a CryptoKey.
    return { ok: false, stage: "store", error: describe(error) };
  }
  const back = await load(credential.id);
  if (back.kind !== "usable") return { ok: false, stage: "read-back", error: `read back as: ${back.kind}` };
  return { ok: true, credential: back.credential };
}

export type LoadResult =
  | { kind: "usable"; credential: StoredCredential }
  | { kind: "none" }
  | { kind: "unusable"; detail: string }
  | { kind: "storage-error"; error: string };

export async function load(id: RecordId): Promise<LoadResult> {
  let record: unknown;
  try {
    record = await tx(KEYS, "readonly", (s) => s.get(id));
  } catch (error) {
    return { kind: "storage-error", error: describe(error) };
  }
  if (record === undefined) return { kind: "none" };
  if (!usable(record)) {
    const key = (record as { privateKey?: unknown })?.privateKey;
    return { kind: "unusable", detail: key === null ? "privateKey came back null" : `privateKey is ${Object.prototype.toString.call(key)}` };
  }
  return { kind: "usable", credential: record };
}

export async function remove(id: RecordId): Promise<void> {
  await tx(KEYS, "readwrite", (s) => s.delete(id));
}

/** Sign bytes with a stored private key. ECDSA P-256, SHA-256; Web Crypto yields r‖s (64 bytes). */
export async function sign(credential: StoredCredential, data: Uint8Array<ArrayBuffer>): Promise<string> {
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, credential.privateKey, data);
  return b64url(signature);
}

/** Verify locally with the public key, as a cross-check of the server's verdict. */
export async function verifyLocally(credential: StoredCredential, data: Uint8Array<ArrayBuffer>, signature: string): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    "spki",
    fromB64url(credential.publicKeySpki),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, fromB64url(signature), data);
}

/** True when the browser refuses to export the private key, which is the property being tested. */
export async function exportRefused(credential: StoredCredential): Promise<boolean> {
  for (const format of ["pkcs8", "jwk"] as const) {
    try {
      await crypto.subtle.exportKey(format, credential.privateKey);
      return false;
    } catch {
      /* refused, as it must be */
    }
  }
  return true;
}

/** Record what this page load found, for the restart history. Keeps the last 30. */
export async function recordLaunch(found: LaunchEntry["found"], deviceId: string | null): Promise<LaunchEntry[]> {
  try {
    await tx(LAUNCHES, "readwrite", (s) => s.add({ at: Date.now(), context: context(), found, deviceId } satisfies LaunchEntry));
    const all = await tx<LaunchEntry[]>(LAUNCHES, "readonly", (s) => s.getAll() as IDBRequest<LaunchEntry[]>);
    return all.slice(-30);
  } catch {
    return [];
  }
}

export async function clearLaunches(): Promise<void> {
  await tx(LAUNCHES, "readwrite", (s) => s.clear());
}

function describe(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
