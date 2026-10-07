"use client";

/**
 * Developer-only feasibility test for the Option 2 device stamp
 * (`/device-crypto-test`, enabled by `DEVICE_CRYPTO_TEST=1`).
 *
 * Answers, on a real phone, inside the installed app: can this PWA make a
 * non-exportable ECDSA P-256 key, keep the CryptoKey in its IndexedDB across
 * full restarts, and sign fresh server challenges with it that Node verifies?
 * And can the same installed app scan a QR code itself, so the scan, the key
 * and the proof all happen in one storage context?
 *
 * Shows only public material: the public key's fingerprint, never the private
 * key. Not connected to the real device store or the device gate.
 */

import * as React from "react";
import {
  clear,
  clearLaunches,
  context,
  exportRefused,
  fromB64url,
  generate,
  load,
  recordLaunch,
  sign,
  verifyLocally,
  type LaunchEntry,
  type StoredCredential,
} from "@/lib/device-crypto-test/keystore";
import { cameraAvailable, classifyQr, createScanner, type Scanner } from "@/lib/device-crypto-test/scanner";

type Tone = "ok" | "bad" | "info";
interface Line {
  at: number;
  tone: Tone;
  text: string;
}

const card: React.CSSProperties = { background: "#fff", borderRadius: 16, padding: 16, boxShadow: "0 4px 18px rgba(16,21,58,.08)" };
const btn: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid #c9cde6",
  background: "#fff",
  fontWeight: 700,
  fontSize: 14,
  cursor: "pointer",
};
const toneColor: Record<Tone, string> = { ok: "#0f7a52", bad: "#b42318", info: "#10153a" };

interface Proof {
  challengeId: string;
  signature: string;
  publicKeySpki: string;
  purpose: "enroll" | "verify";
}

async function api<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

export function CryptoTest({
  enrollQrSvg,
  normalQrSvg,
  enrollUrl,
  normalUrl,
  openedWithEnrollToken,
}: {
  enrollQrSvg: string | null;
  normalQrSvg: string | null;
  enrollUrl: string | null;
  normalUrl: string | null;
  openedWithEnrollToken: string | null;
}) {
  const [credential, setCredential] = React.useState<StoredCredential | null>(null);
  const [launches, setLaunches] = React.useState<LaunchEntry[]>([]);
  const [lines, setLines] = React.useState<Line[]>([]);
  const [env, setEnv] = React.useState<Record<string, string>>({});
  const [lastProof, setLastProof] = React.useState<Proof | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const started = React.useRef(false);

  const log = React.useCallback((tone: Tone, text: string) => {
    setLines((current) => [{ at: Date.now(), tone, text }, ...current].slice(0, 60));
  }, []);

  /* ── On every page load: what survived? ────────────────────────────────── */
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const info: Record<string, string> = {
        context: context(),
        secureContext: String(window.isSecureContext),
        webCrypto: String(Boolean(crypto?.subtle)),
        indexedDB: String(typeof indexedDB !== "undefined"),
        camera: String(cameraAvailable()),
        barcodeDetector: String("BarcodeDetector" in window),
        userAgent: navigator.userAgent,
      };
      try {
        info.storagePersisted = String((await navigator.storage?.persisted?.()) ?? "n/a");
        const estimate = await navigator.storage?.estimate?.();
        if (estimate?.usage !== undefined) info.storageUsage = `${Math.round(estimate.usage / 1024)} KiB`;
      } catch {
        /* optional */
      }
      setEnv(info);

      const found = await load();
      if (found.kind === "usable") {
        setCredential(found.credential);
        log("ok", `Key loaded after restart: ${found.credential.fingerprint} (created ${new Date(found.credential.createdAt).toLocaleString()} in ${found.credential.createdIn})`);
      } else if (found.kind === "none") {
        log("info", "No stored credential in this context.");
      } else if (found.kind === "unusable") {
        log("bad", `Stored record is NOT a usable key: ${found.detail}`);
      } else {
        log("bad", `IndexedDB error: ${found.error}`);
      }
      setLaunches(
        await recordLaunch(
          found.kind === "usable" ? "usable-key" : found.kind === "none" ? "no-key" : found.kind === "unusable" ? "unusable-record" : "storage-error",
        ),
      );

      if (openedWithEnrollToken) {
        log("info", `Opened from an enrollment-style QR in the ${context()} context (token ${openedWithEnrollToken.slice(0, 9)}…).`);
        if (context() === "browser") {
          log("bad", "This is the browser, not the installed app: a key made here belongs to the browser's storage, not the app's.");
        }
      }
    })();
  }, [log, openedWithEnrollToken]);

  /* ── Actions ───────────────────────────────────────────────────────────── */

  async function onGenerate(reason = "Generate Device Credential") {
    log("info", `${reason}…`);
    const result = await generate();
    if (!result.ok) {
      log("bad", `FAILED at ${result.stage}: ${result.error}`);
      return null;
    }
    setCredential(result.credential);
    log("ok", `Key generated (ECDSA P-256, extractable=false). Key stored in IndexedDB and read back: ${result.credential.fingerprint}`);
    const refused = await exportRefused(result.credential);
    log(refused ? "ok" : "bad", refused ? "Private key export refused by the browser (pkcs8 and jwk) ✓" : "Private key COULD be exported — not acceptable");
    return result.credential;
  }

  async function onCheck() {
    const found = await load();
    if (found.kind === "usable") {
      setCredential(found.credential);
      log("ok", `Stored credential present and usable: ${found.credential.fingerprint}; extractable=${found.credential.privateKey.extractable}`);
    } else {
      setCredential(null);
      log(found.kind === "none" ? "info" : "bad", found.kind === "none" ? "No stored credential." : `Not usable: ${JSON.stringify(found)}`);
    }
  }

  /** The production-shaped proof: server challenge → sign → server verifies with Node. */
  async function prove(purpose: "enroll" | "verify", with_: StoredCredential | null = credential): Promise<boolean> {
    const current = with_ ?? (await load().then((r) => (r.kind === "usable" ? r.credential : null)));
    if (!current) {
      log("bad", "No usable key in this context → a real device check would BLOCK here.");
      return false;
    }
    const challenge = await api<{ challengeId?: string; challenge?: string; error?: string }>("/api/pwa/device-crypto-test/challenge", {
      purpose,
      keyFingerprint: current.fingerprint,
    });
    if (challenge.status !== 200 || !challenge.body.challenge || !challenge.body.challengeId) {
      log("bad", `Challenge request failed (${challenge.status}): ${challenge.body.error ?? ""}`);
      return false;
    }
    const data = fromB64url(challenge.body.challenge);
    let signature: string;
    try {
      signature = await sign(current, data);
    } catch (error) {
      log("bad", `Signing FAILED: ${String(error)}`);
      return false;
    }
    log("ok", `Challenge signed (${purpose}).`);
    const locallyValid = await verifyLocally(current, data, signature);
    log(locallyValid ? "ok" : "bad", `Local verification with the public key: ${locallyValid ? "valid" : "INVALID"}`);
    const proof: Proof = { challengeId: challenge.body.challengeId, signature, publicKeySpki: current.publicKeySpki, purpose };
    const verdict = await api<{ ok: boolean; fingerprint?: string; reason?: string }>("/api/pwa/device-crypto-test/verify", proof);
    setLastProof(proof);
    if (verdict.body.ok && verdict.body.fingerprint === current.fingerprint) {
      log("ok", `Signature verified by the server (Node crypto) for ${current.fingerprint} ✓`);
      return true;
    }
    log("bad", `Server verification FAILED: ${verdict.body.reason ?? verdict.status}`);
    return false;
  }

  async function onReplay() {
    if (!lastProof) {
      log("info", "Sign a challenge first.");
      return;
    }
    const verdict = await api<{ ok: boolean; reason?: string }>("/api/pwa/device-crypto-test/verify", lastProof);
    log(verdict.body.ok ? "bad" : "ok", verdict.body.ok ? "Replay ACCEPTED — not acceptable" : `Replayed signature refused by the server (${verdict.body.reason}) ✓`);
  }

  async function onClear() {
    await clear();
    setCredential(null);
    log("info", "Test credential cleared. This context is now 'unenrolled'.");
  }

  async function onPersist() {
    try {
      const granted = await navigator.storage?.persist?.();
      log(granted ? "ok" : "info", `navigator.storage.persist(): ${String(granted)}`);
      setEnv((e) => ({ ...e, storagePersisted: String(granted) }));
    } catch (error) {
      log("bad", `persist() failed: ${String(error)}`);
    }
  }

  /** What the scanner does with a decoded QR, without leaving this page. */
  async function onScanned(text: string) {
    setScanning(false);
    const qr = classifyQr(text, window.location.origin);
    if (qr.kind === "enrollment") {
      log("info", `Enrollment-style QR scanned inside the ${context()} (token ${qr.token.slice(0, 9)}…). Running enrollment test…`);
      const made = credential ?? (await onGenerate("No key yet: generating"));
      if (made) await prove("enroll", made);
    } else if (qr.kind === "normal") {
      log("info", `Normal FO QR scanned inside the ${context()} (${qr.path}). Running device check…`);
      const ok = await prove("verify");
      log(ok ? "ok" : "bad", ok ? "Device proof OK → production would continue to the normal FO sign-in." : "Device proof failed → production would BLOCK.");
    } else {
      log("info", `Scanned something else: ${qr.text.slice(0, 80)}`);
    }
  }

  /* ── View ──────────────────────────────────────────────────────────────── */

  const restartsWithKey = launches.filter((l) => l.found === "usable-key").length;

  return (
    <div style={{ minHeight: "100%", background: "#f6f7fc", padding: 16, fontFamily: "system-ui, sans-serif", color: "#10153a" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: ".06em", color: "#4b3fd6" }}>DEVELOPER TEST · NOT A PRODUCT FEATURE</div>
          <h1 style={{ margin: "4px 0 0", fontSize: 22 }}>Device credential feasibility</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "#4a5072" }}>
            Option 2 device stamp: non-exportable ECDSA P-256 key in this app&rsquo;s IndexedDB, proved by signing server
            challenges. Not connected to real enrollment.
          </p>
        </div>

        <section style={card}>
          <strong>Status in this context ({env.context ?? "…"})</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 14, lineHeight: 1.7 }}>
            <li>Credential: {credential ? <b style={{ color: toneColor.ok }}>present · {credential.fingerprint}</b> : <b>none</b>}</li>
            <li>Created in: {credential ? `${credential.createdIn}, ${new Date(credential.createdAt).toLocaleString()}` : "—"}</li>
            <li>
              Page loads that found a usable key: <b>{restartsWithKey}</b> of {launches.length} recorded
            </li>
            <li>Storage persisted: {env.storagePersisted ?? "…"}</li>
          </ul>
        </section>

        <section style={{ ...card, display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button style={btn} onClick={() => void onGenerate()}>Generate Device Credential</button>
          <button style={btn} onClick={() => void onCheck()}>Check Stored Credential</button>
          <button style={btn} onClick={() => void prove("verify")}>Sign Test Challenge + Verify Signature</button>
          <button style={btn} onClick={() => void onReplay()}>Replay Last Signature</button>
          <button style={btn} onClick={() => void onPersist()}>Request Persistent Storage</button>
          <button style={{ ...btn, background: "#4b3fd6", color: "#fff", borderColor: "#4b3fd6" }} onClick={() => setScanning(true)}>
            Scan QR (inside this app)
          </button>
          <button style={{ ...btn, color: "#b42318" }} onClick={() => void onClear()}>Clear Test Credential</button>
          <button style={btn} onClick={() => void clearLaunches().then(() => setLaunches([]))}>Clear Restart History</button>
        </section>

        {scanning ? <ScanPanel onResult={(t) => void onScanned(t)} onClose={() => setScanning(false)} log={log} /> : null}

        <section style={card}>
          <strong>Results</strong>
          <ol style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
            {lines.map((l) => (
              <li key={`${l.at}-${l.text}`} style={{ color: toneColor[l.tone] }}>
                {new Date(l.at).toLocaleTimeString()} — {l.text}
              </li>
            ))}
          </ol>
        </section>

        <section style={card}>
          <strong>Restart history (page loads in this context)</strong>
          <ol style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
            {launches.map((l, i) => (
              <li key={`${l.at}-${i}`} style={{ color: l.found === "usable-key" ? toneColor.ok : l.found === "no-key" ? toneColor.info : toneColor.bad }}>
                {new Date(l.at).toLocaleString()} · {l.context} · {l.found}
              </li>
            ))}
          </ol>
        </section>

        {enrollQrSvg && normalQrSvg ? (
          <section style={{ ...card, display: "flex", flexWrap: "wrap", gap: 18 }}>
            <TestQr title="Enrollment-style test QR" svg={enrollQrSvg} url={enrollUrl} />
            <TestQr title="Normal FO QR" svg={normalQrSvg} url={normalUrl} />
            <p style={{ flexBasis: "100%", margin: 0, fontSize: 12, color: "#4a5072" }}>
              Show these on another screen and scan them with <b>Scan QR</b> above. The enrollment code here is a
              throwaway test value, not a real enrollment.
            </p>
          </section>
        ) : null}

        <section style={card}>
          <strong>Context</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, lineHeight: 1.6, wordBreak: "break-word" }}>
            {Object.entries(env).map(([k, v]) => (
              <li key={k}>
                {k}: {v}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function TestQr({ title, svg, url }: { title: string; svg: string; url: string | null }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{title}</span>
      {/* eslint-disable-next-line @next/next/no-img-element -- inline SVG data URI */}
      <img src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} alt={title} width={180} height={180} />
      <code style={{ fontSize: 11, maxWidth: 220, wordBreak: "break-all" }}>{url}</code>
    </div>
  );
}

function ScanPanel({ onResult, onClose, log }: { onResult: (text: string) => void; onClose: () => void; log: (t: Tone, s: string) => void }) {
  const video = React.useRef<HTMLVideoElement>(null);
  const [status, setStatus] = React.useState("Starting camera…");
  // Callbacks through refs: the parent re-renders on every log line, and the
  // camera must not restart each time it does.
  const onResultRef = React.useRef(onResult);
  const logRef = React.useRef(log);
  React.useEffect(() => {
    onResultRef.current = onResult;
    logRef.current = log;
  });

  React.useEffect(() => {
    let stream: MediaStream | null = null;
    let scanner: Scanner | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stopped) return;
        const el = video.current!;
        el.srcObject = stream;
        await el.play();
        scanner = await createScanner();
        setStatus(`Point at a QR code (decoder: ${scanner.kind})`);
        logRef.current("info", `Camera opened inside the ${context()}; decoder ${scanner.kind}.`);
        const tick = async () => {
          if (stopped || !scanner) return;
          try {
            const found = await scanner.detect(el);
            if (found[0]) {
              onResultRef.current(found[0]);
              return;
            }
          } catch {
            /* a bad frame; keep going */
          }
          timer = setTimeout(() => void tick(), 250);
        };
        void tick();
      } catch (error) {
        setStatus(`Camera unavailable: ${String(error)}`);
        logRef.current("bad", `Camera FAILED: ${String(error)}`);
      }
    })();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      scanner?.dispose();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      <strong>In-app QR scanner</strong>
      <video ref={video} playsInline muted autoPlay style={{ width: "100%", maxHeight: 360, background: "#000", borderRadius: 12, objectFit: "cover" }} />
      <span style={{ fontSize: 13 }}>{status}</span>
      <button style={btn} onClick={onClose}>
        Close scanner
      </button>
    </section>
  );
}
