/**
 * FabOrchestrator's device key, as this app's sign-in reads it. Browser only.
 *
 * FabOrchestrator owns approved devices (its Admin → Devices). Its own
 * `/device-enroll` page, served here through the gateway, makes the key on this
 * origin and keeps it in IndexedDB; this file only reads it, to sign FO's
 * sign-in challenge. The storage layout and the signed message below must stay
 * the ones FabOrchestrator uses (`shared/lib/device-key.ts` and
 * `shared/lib/device-approval.ts` there).
 */

import type { FoDeviceProof } from "@/lib/faborch/client";

const DB_NAME = "fo-device";
const STORE = "key";
const RECORD_ID = "device";

/**
 * FabOrchestrator's stored device key, or null. Never creates the database: a
 * database made here, empty, would stop FabOrchestrator's page from adding its
 * store when the device is enrolled later.
 */
function readKey(): Promise<{ deviceId: string; privateKey: CryptoKey } | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const open = indexedDB.open(DB_NAME);
    // Fires only when the database does not exist yet: abort, so it is not created.
    open.onupgradeneeded = () => open.transaction?.abort();
    open.onerror = () => resolve(null);
    open.onblocked = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.close();
        return resolve(null);
      }
      const get = db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD_ID);
      get.onsuccess = () => {
        db.close();
        const record = get.result as { deviceId?: unknown; privateKey?: unknown } | undefined;
        resolve(
          record && typeof record.deviceId === "string" && record.privateKey instanceof CryptoKey
            ? { deviceId: record.deviceId, privateKey: record.privateKey }
            : null,
        );
      };
      get.onerror = () => {
        db.close();
        resolve(null);
      };
    };
  });
}

function toB64url(bytes: ArrayBuffer): string {
  let text = "";
  for (const b of new Uint8Array(bytes)) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * This phone's proof for signing in as `email`, or null when it holds no
 * FabOrchestrator device key. `email` must be exactly what the form sends:
 * FabOrchestrator checks the signature over its lower-case form.
 */
export async function foDeviceSignInProof(email: string): Promise<FoDeviceProof | null> {
  const key = await readKey();
  if (!key) return null;
  const res = await fetch("/api/auth/device-challenge", { cache: "no-store" });
  if (!res.ok) return null;
  const { challenge } = (await res.json()) as { challenge?: unknown };
  if (typeof challenge !== "string") return null;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(`sign-in|${email.toLowerCase()}|${challenge}`),
  );
  return { deviceId: key.deviceId, challenge, signature: toB64url(signature) };
}
