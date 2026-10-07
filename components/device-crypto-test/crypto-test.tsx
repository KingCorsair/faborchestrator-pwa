"use client";

/**
 * Developer-only feasibility test for the Option 2 device stamp, driven by the
 * real QR workflow (`/device-crypto-test`, enabled by `DEVICE_CRYPTO_TEST=1`).
 *
 *   computer:  Create Enrollment QR  ·  Normal Access QR  ·  Revoke
 *   phone:     open the installed test app → Scan Enrollment QR
 *              → key made here, kept in this app's IndexedDB, public key
 *                registered → "Device enrolled successfully as DEVICE-nnn"
 *              → close and reopen the app → "Stored device: DEVICE-nnn"
 *              → Scan Normal Access QR → challenge signed with the stored key
 *                → "Device verified successfully — DEVICE-nnn", or BLOCKED
 *
 * Isolated: the server side is an in-memory test registry, not the production
 * device store. Shows only public material (device id, public-key fingerprint),
 * never the private key.
 */

import * as React from "react";
import {
  clearLaunches,
  context,
  exportRefused,
  fromB64url,
  generateAndStore,
  load,
  put,
  recordLaunch,
  remove,
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
interface Banner {
  tone: Tone;
  title: string;
  detail?: string;
}

interface AdminState {
  now: number;
  enrollments: { enrollmentId: string; createdAt: number; expiresAt: number; state: "unused" | "used" | "expired"; deviceId: string | null }[];
  devices: { deviceId: string; status: "APPROVED" | "REVOKED"; fingerprint: string; createdAt: number; lastVerifiedAt: number | null; revokedAt: number | null }[];
}
interface IssuedEnrollment {
  enrollmentId: string;
  expiresAt: number;
  url: string;
  qrSvg: string;
}

const PALETTE = { ok: "#0f7a52", bad: "#b42318", info: "#10153a", okBg: "#e7f7ef", badBg: "#fdecea", infoBg: "#eef0fb" };
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
const bigBtn: React.CSSProperties = { ...btn, background: "#4b3fd6", color: "#fff", borderColor: "#4b3fd6", padding: "16px 18px", fontSize: 16, flex: "1 1 220px" };

async function api<T>(action: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`/api/pwa/device-crypto-test/${action}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

const time = (ms: number | null) => (ms ? new Date(ms).toLocaleTimeString() : "—");

export function CryptoTest({
  normalQrSvg,
  normalUrl,
  openedWithEnrollToken,
}: {
  normalQrSvg: string | null;
  normalUrl: string | null;
  openedWithEnrollToken: string | null;
}) {
  const [device, setDevice] = React.useState<StoredCredential | null>(null);
  const [launches, setLaunches] = React.useState<LaunchEntry[]>([]);
  const [lines, setLines] = React.useState<Line[]>([]);
  const [banner, setBanner] = React.useState<Banner | null>(null);
  const [env, setEnv] = React.useState<Record<string, string>>({});
  const [scanMode, setScanMode] = React.useState<"enrollment" | "access" | null>(null);
  const [busy, setBusy] = React.useState(false);
  const started = React.useRef(false);

  const log = React.useCallback((tone: Tone, text: string) => {
    setLines((current) => [{ at: Date.now(), tone, text }, ...current].slice(0, 80));
  }, []);

  /* ── Enrollment: scan → automatic ──────────────────────────────────────── */

  const enroll = React.useCallback(
    async (token: string) => {
      setBusy(true);
      setBanner({ tone: "info", title: "Enrolling this device…" });
      try {
        log("info", `Enrollment QR read in the ${context()}. Asking the server whether the code is still usable…`);
        const start = await api<{ ok?: boolean; problem?: string; challengeId?: string; challenge?: string; enrollmentId?: string }>("enroll-start", { token });
        if (!start.body.ok || !start.body.challenge || !start.body.challengeId) {
          const problem = start.body.problem ?? `status ${start.status}`;
          const title =
            problem === "used"
              ? "This Enrollment QR has already been used"
              : problem === "expired"
                ? "This Enrollment QR has expired"
                : "This Enrollment QR is not valid";
          setBanner({ tone: "bad", title, detail: "No key was created and nothing on this device changed." });
          log("bad", `${title} (${problem}).`);
          return;
        }
        log("ok", `Enrollment code valid (${start.body.enrollmentId}).`);

        const made = await generateAndStore("pending");
        if (!made.ok) {
          setBanner({
            tone: "bad",
            title: "This app could not keep a device key",
            detail: `Failed at ${made.stage}: ${made.error}. The enrollment was not used.`,
          });
          log("bad", `Key ${made.stage} FAILED: ${made.error}. This is the feasibility result for this context.`);
          return;
        }
        log("ok", `Key generated (ECDSA P-256, extractable=false) and stored in IndexedDB; read back OK (${made.credential.fingerprint}).`);
        const refused = await exportRefused(made.credential);
        log(refused ? "ok" : "bad", refused ? "Private key export refused by the browser ✓" : "Private key COULD be exported — not acceptable");

        const signature = await sign(made.credential, fromB64url(start.body.challenge));
        const finish = await api<{ ok?: boolean; deviceId?: string; problem?: string; detail?: string }>("enroll-finish", {
          token,
          challengeId: start.body.challengeId,
          publicKeySpki: made.credential.publicKeySpki,
          signature,
        });
        if (!finish.body.ok || !finish.body.deviceId) {
          await remove("pending");
          const title = finish.body.problem === "used" ? "This Enrollment QR was used by another device first" : "Enrollment refused by the server";
          setBanner({ tone: "bad", title, detail: `${finish.body.problem ?? ""} ${finish.body.detail ?? ""}`.trim() });
          log("bad", `${title}. The new key was discarded.`);
          return;
        }

        const previous = (await load("device")).kind === "usable" ? device?.deviceId : null;
        const stored = await put({ ...made.credential, id: "device", deviceId: finish.body.deviceId });
        await remove("pending");
        if (!stored.ok) {
          setBanner({ tone: "bad", title: "Enrolled on the server, but the key could not be kept here", detail: stored.error });
          log("bad", `Final store FAILED: ${stored.error}`);
          return;
        }
        setDevice(stored.credential);
        setBanner({
          tone: "ok",
          title: `Device enrolled successfully as ${stored.credential.deviceId}`,
          detail: `Public key registered with the server; status APPROVED. Key fingerprint ${stored.credential.fingerprint}.`,
        });
        log("ok", `Server created ${stored.credential.deviceId} (APPROVED) with this app's public key. Enrollment QR consumed.`);
        if (previous) log("info", `This app's previous ${previous} key was replaced here; revoke ${previous} on the server.`);
        try {
          const persisted = await navigator.storage?.persist?.();
          log("info", `navigator.storage.persist(): ${String(persisted)}`);
          setEnv((e) => ({ ...e, storagePersisted: String(persisted) }));
        } catch {
          /* optional */
        }
      } catch (error) {
        setBanner({ tone: "bad", title: "Enrollment failed", detail: String(error) });
        log("bad", `Enrollment error: ${String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [device, log],
  );

  /* ── Everyday access: scan → challenge → signature → status ────────────── */

  const access = React.useCallback(async () => {
    setBusy(true);
    setBanner({ tone: "info", title: "Checking this device…" });
    try {
      const found = await load("device");
      if (found.kind !== "usable" || !found.credential.deviceId) {
        setBanner({ tone: "bad", title: "BLOCKED — no enrolled device credential", detail: "This app has never been enrolled (or its key is gone). Scan an Enrollment QR first." });
        log("bad", `Normal Access QR: no enrolled key in this ${context()} (${found.kind}) → BLOCKED.`);
        return;
      }
      const cred = found.credential;
      const deviceId = cred.deviceId!;
      log("info", `Normal Access QR: claiming ${deviceId}; asking for a challenge…`);
      const start = await api<{ ok?: boolean; challengeId?: string; challenge?: string; problem?: string }>("access-start", { deviceId });
      if (!start.body.ok || !start.body.challenge || !start.body.challengeId) {
        setBanner({ tone: "bad", title: `BLOCKED — the server does not know ${deviceId}`, detail: "The test server may have restarted (its registry is in memory)." });
        log("bad", `access-start refused: ${start.body.problem ?? start.status}`);
        return;
      }
      const data = fromB64url(start.body.challenge);
      const signature = await sign(cred, data);
      const locally = await verifyLocally(cred, data, signature);
      log(locally ? "ok" : "bad", `Challenge signed with the stored private key (local check: ${locally ? "valid" : "INVALID"}).`);
      const finish = await api<{ result?: string; detail?: string }>("access-finish", { deviceId, challengeId: start.body.challengeId, signature });
      if (finish.body.result === "approved") {
        setBanner({ tone: "ok", title: `Device verified successfully — ${deviceId}`, detail: "Signature verified against the public key registered at enrollment; status APPROVED. Production would continue to the normal FO sign-in." });
        log("ok", `Server verified the signature for ${deviceId}: APPROVED.`);
      } else if (finish.body.result === "revoked") {
        setBanner({ tone: "bad", title: `BLOCKED — ${deviceId} is REVOKED`, detail: "The signature was valid: the key still proves which device this is. The server's status decides, and it says no." });
        log("bad", `Signature valid, but ${deviceId} is REVOKED → BLOCKED.`);
      } else {
        setBanner({ tone: "bad", title: "BLOCKED — device proof not accepted", detail: `${finish.body.result ?? finish.status} ${finish.body.detail ?? ""}` });
        log("bad", `access-finish: ${JSON.stringify(finish.body)}`);
      }
    } catch (error) {
      setBanner({ tone: "bad", title: "Device check failed", detail: String(error) });
      log("bad", `Access error: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [log]);

  /** One handler for every decoded QR, whichever button opened the scanner. */
  const onScanned = React.useCallback(
    async (text: string) => {
      setScanMode(null);
      const qr = classifyQr(text, window.location.origin);
      if (qr.kind === "enrollment") await enroll(qr.token);
      else if (qr.kind === "normal") await access();
      else {
        setBanner({ tone: "bad", title: "Not a test QR code", detail: qr.text.slice(0, 120) });
        log("info", `Scanned something else: ${qr.text.slice(0, 80)}`);
      }
    },
    [access, enroll, log],
  );

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
      } catch {
        /* optional */
      }
      setEnv(info);

      const found = await load("device");
      if (found.kind === "usable") {
        setDevice(found.credential);
        log("ok", `Stored device: ${found.credential.deviceId} — key loaded from IndexedDB on this launch (fingerprint ${found.credential.fingerprint}, created ${new Date(found.credential.createdAt).toLocaleString()} in ${found.credential.createdIn}). No new key generated.`);
      } else if (found.kind === "none") {
        log("info", "No enrolled device in this context.");
      } else {
        log("bad", `Stored device record unusable: ${JSON.stringify(found)}`);
      }
      setLaunches(
        await recordLaunch(
          found.kind === "usable" ? "usable-key" : found.kind === "none" ? "no-key" : found.kind === "unusable" ? "unusable-record" : "storage-error",
          found.kind === "usable" ? found.credential.deviceId : null,
        ),
      );
      await remove("pending").catch(() => {});

      if (openedWithEnrollToken) {
        if (context() === "installed-app") {
          log("info", "This installed app was opened by an Enrollment QR link: enrolling automatically.");
          await enroll(openedWithEnrollToken);
        } else {
          setBanner({
            tone: "bad",
            title: "Opened in the browser, not the installed app",
            detail: "Not enrolling here: a key made in the browser would belong to the browser's storage, not the app's. Open the installed FO Crypto Test app and scan the QR there. (The QR is still unused.)",
          });
          log("bad", "Enrollment QR opened in the browser context. Refusing to enroll here, so the QR is not wasted.");
        }
      }
    })();
  }, [enroll, log, openedWithEnrollToken]);

  const usableLaunches = launches.filter((l) => l.found === "usable-key").length;
  const bannerColors = banner ? { color: PALETTE[banner.tone], background: banner.tone === "ok" ? PALETTE.okBg : banner.tone === "bad" ? PALETTE.badBg : PALETTE.infoBg } : {};

  return (
    <div style={{ minHeight: "100%", background: "#f6f7fc", padding: 16, fontFamily: "system-ui, sans-serif", color: "#10153a" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: ".06em", color: "#4b3fd6" }}>DEVELOPER TEST · NOT A PRODUCT FEATURE</div>
          <h1 style={{ margin: "4px 0 0", fontSize: 22 }}>Device enrollment by QR — Web Crypto key</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "#4a5072" }}>
            Jothi&rsquo;s Option 2 feasibility test. Isolated test server; not the real device store.
          </p>
        </div>

        <section style={card}>
          <div style={{ fontSize: 13, color: "#4a5072" }}>This app ({env.context ?? "…"})</div>
          <div data-testid="stored-device" style={{ fontSize: 20, fontWeight: 800, margin: "4px 0" }}>
            {device ? `Stored device: ${device.deviceId}` : "No enrolled device"}
          </div>
          <div style={{ fontSize: 13, color: "#4a5072" }}>
            {device ? `Key fingerprint ${device.fingerprint} · created ${new Date(device.createdAt).toLocaleString()} in ${device.createdIn}` : "Scan an Enrollment QR to enroll."}
            <br />
            Launches that found the key: <b>{usableLaunches}</b> of {launches.length} · persistent storage: {env.storagePersisted ?? "…"}
          </div>
        </section>

        <section style={{ ...card, display: "flex", flexWrap: "wrap", gap: 10 }}>
          <button style={bigBtn} disabled={busy} onClick={() => setScanMode("enrollment")}>
            Scan Enrollment QR
          </button>
          <button style={bigBtn} disabled={busy} onClick={() => setScanMode("access")}>
            Scan Normal Access QR
          </button>
          <PasteQr onText={(t) => void onScanned(t)} disabled={busy} />
        </section>

        {scanMode ? <ScanPanel mode={scanMode} onResult={(t) => void onScanned(t)} onClose={() => setScanMode(null)} log={log} /> : null}

        {banner ? (
          <section data-testid="banner" role="status" style={{ ...card, ...bannerColors, border: `2px solid ${PALETTE[banner.tone]}` }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{banner.title}</div>
            {banner.detail ? <div style={{ fontSize: 14, marginTop: 6, color: "#10153a" }}>{banner.detail}</div> : null}
          </section>
        ) : null}

        <TestAdmin normalQrSvg={normalQrSvg} normalUrl={normalUrl} />

        <section style={card}>
          <strong>Activity</strong>
          <ol style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
            {lines.map((l) => (
              <li key={`${l.at}-${l.text}`} style={{ color: PALETTE[l.tone] }}>
                {new Date(l.at).toLocaleTimeString()} — {l.text}
              </li>
            ))}
          </ol>
        </section>

        <section style={card}>
          <strong>Launch history (this context)</strong>
          <ol style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
            {launches.map((l, i) => (
              <li key={`${l.at}-${i}`} style={{ color: l.found === "usable-key" ? PALETTE.ok : l.found === "no-key" ? PALETTE.info : PALETTE.bad }}>
                {new Date(l.at).toLocaleString()} · {l.context} · {l.found}
                {l.deviceId ? ` · ${l.deviceId}` : ""}
              </li>
            ))}
          </ol>
          <button style={{ ...btn, marginTop: 8 }} onClick={() => void clearLaunches().then(() => setLaunches([]))}>
            Clear launch history
          </button>
        </section>

        <DebugTools log={log} onDeviceCleared={() => setDevice(null)} />

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

/* ── Test admin: the computer's half ─────────────────────────────────────── */

function TestAdmin({ normalQrSvg, normalUrl }: { normalQrSvg: string | null; normalUrl: string | null }) {
  const [state, setState] = React.useState<AdminState | null>(null);
  const [issued, setIssued] = React.useState<IssuedEnrollment | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const res = await api<AdminState>("state").catch(() => null);
    if (res && res.status === 200) setState(res.body);
  }, []);

  React.useEffect(() => {
    void refresh();
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 2000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [refresh]);

  async function create() {
    setError(null);
    const res = await api<IssuedEnrollment & { error?: string }>("enrollments", {});
    if (res.status !== 201) {
      setError(res.body.error ?? `status ${res.status}`);
      return;
    }
    setIssued(res.body);
    void refresh();
  }

  async function setStatus(deviceId: string, action: "revoke" | "reinstate") {
    await api(action, { deviceId });
    void refresh();
  }

  const current = issued ? state?.enrollments.find((e) => e.enrollmentId === issued.enrollmentId) : undefined;
  const left = issued ? Math.max(0, issued.expiresAt - now) : 0;
  const enrollState = current?.state ?? (left > 0 ? "unused" : "expired");

  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <strong>Test admin (show this on the computer)</strong>
        <div style={{ fontSize: 12, color: "#4a5072" }}>Isolated test registry, in memory. Not the real device store.</div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 240 }}>
          <span style={{ fontSize: 16, fontWeight: 800 }}>Enrollment QR</span>
          <button style={{ ...btn, background: "#10153a", color: "#fff" }} onClick={() => void create()}>
            Create Enrollment QR
          </button>
          {error ? <span style={{ color: PALETTE.bad, fontSize: 13 }}>{error}</span> : null}
          {issued ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- inline SVG data URI */}
              <img
                src={`data:image/svg+xml;utf8,${encodeURIComponent(issued.qrSvg)}`}
                alt="Enrollment QR"
                width={220}
                height={220}
                style={{ opacity: enrollState === "unused" ? 1 : 0.25 }}
              />
              <span data-testid="enrollment-state" style={{ fontSize: 14, fontWeight: 800, color: enrollState === "unused" ? PALETTE.ok : PALETTE.bad }}>
                {enrollState === "unused"
                  ? `UNUSED · expires in ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`
                  : enrollState === "used"
                    ? `USED by ${current?.deviceId}`
                    : "EXPIRED"}
              </span>
              <span style={{ fontSize: 12 }}>Enrollment ID: {issued.enrollmentId}</span>
              <code style={{ fontSize: 10, maxWidth: 260, wordBreak: "break-all" }}>{issued.url}</code>
            </>
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 220 }}>
          <span style={{ fontSize: 16, fontWeight: 800 }}>Normal Access QR</span>
          <span style={{ fontSize: 12, color: "#4a5072" }}>The everyday FO QR. Enrolls nothing.</span>
          {normalQrSvg ? (
            // eslint-disable-next-line @next/next/no-img-element -- inline SVG data URI
            <img src={`data:image/svg+xml;utf8,${encodeURIComponent(normalQrSvg)}`} alt="Normal Access QR" width={220} height={220} />
          ) : (
            <span style={{ color: PALETTE.bad, fontSize: 13 }}>PUBLIC_ORIGIN is not set.</span>
          )}
          <code style={{ fontSize: 10 }}>{normalUrl}</code>
        </div>
      </div>

      <div>
        <strong style={{ fontSize: 14 }}>Test devices</strong>
        {state && state.devices.length > 0 ? (
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", marginTop: 6 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#4a5072" }}>
                <th>Device</th>
                <th>Status</th>
                <th>Key fingerprint</th>
                <th>Enrolled</th>
                <th>Last verified</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.devices.map((d) => (
                <tr key={d.deviceId} style={{ borderTop: "1px solid #e3e6f3" }}>
                  <td style={{ fontWeight: 800 }}>{d.deviceId}</td>
                  <td style={{ color: d.status === "APPROVED" ? PALETTE.ok : PALETTE.bad, fontWeight: 800 }}>{d.status}</td>
                  <td style={{ fontSize: 11 }}>{d.fingerprint.slice(0, 16)}…</td>
                  <td>{time(d.createdAt)}</td>
                  <td>{time(d.lastVerifiedAt)}</td>
                  <td>
                    {d.status === "APPROVED" ? (
                      <button style={{ ...btn, color: PALETTE.bad }} onClick={() => void setStatus(d.deviceId, "revoke")}>
                        Revoke {d.deviceId}
                      </button>
                    ) : (
                      <button style={btn} onClick={() => void setStatus(d.deviceId, "reinstate")}>
                        Reinstate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 13, color: "#4a5072" }}>No test devices yet.</div>
        )}
      </div>
    </section>
  );
}

/* ── Scanner ───────────────────────────────────────────────────────────────── */

function ScanPanel({
  mode,
  onResult,
  onClose,
  log,
}: {
  mode: "enrollment" | "access";
  onResult: (text: string) => void;
  onClose: () => void;
  log: (t: Tone, s: string) => void;
}) {
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
        setStatus(`Point at the ${mode === "enrollment" ? "Enrollment" : "Normal Access"} QR (decoder: ${scanner.kind})`);
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
  }, [mode]);

  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      <strong>{mode === "enrollment" ? "Scan Enrollment QR" : "Scan Normal Access QR"}</strong>
      <video ref={video} playsInline muted autoPlay style={{ width: "100%", maxHeight: 360, background: "#000", borderRadius: 12, objectFit: "cover" }} />
      <span style={{ fontSize: 13 }}>{status}</span>
      <button style={btn} onClick={onClose}>
        Close scanner
      </button>
    </section>
  );
}

/** Fallback when there is no camera: paste what the QR says. Runs the same handler. */
function PasteQr({ onText, disabled }: { onText: (text: string) => void; disabled: boolean }) {
  return (
    <form
      style={{ display: "flex", gap: 6, flexBasis: "100%" }}
      onSubmit={(e) => {
        e.preventDefault();
        const value = String(new FormData(e.currentTarget).get("qr") ?? "").trim();
        if (value) onText(value);
      }}
    >
      <input
        name="qr"
        aria-label="QR link"
        placeholder="No camera? Paste the QR link here"
        autoComplete="off"
        style={{ flex: 1, minWidth: 0, padding: "10px 12px", borderRadius: 10, border: "1px solid #c9cde6", fontSize: 14 }}
      />
      <button style={btn} type="submit" disabled={disabled}>
        Use link
      </button>
    </form>
  );
}

/* ── Debug: the manual crypto buttons, on their own key ───────────────────── */

function DebugTools({ log, onDeviceCleared }: { log: (t: Tone, s: string) => void; onDeviceCleared: () => void }) {
  const [last, setLast] = React.useState<Record<string, unknown> | null>(null);

  async function generate() {
    const made = await generateAndStore("debug");
    if (!made.ok) return log("bad", `[debug] FAILED at ${made.stage}: ${made.error}`);
    log("ok", `[debug] Key generated and stored: ${made.credential.fingerprint}; export refused: ${await exportRefused(made.credential)}`);
  }
  async function check() {
    const found = await load("debug");
    log(found.kind === "usable" ? "ok" : "info", `[debug] Stored debug key: ${found.kind === "usable" ? found.credential.fingerprint : found.kind}`);
  }
  async function signVerify() {
    const found = await load("debug");
    if (found.kind !== "usable") return log("info", "[debug] Generate a debug key first.");
    const c = await api<{ challengeId?: string; challenge?: string }>("challenge", { keyFingerprint: found.credential.fingerprint });
    if (!c.body.challenge || !c.body.challengeId) return log("bad", `[debug] challenge failed (${c.status})`);
    const signature = await sign(found.credential, fromB64url(c.body.challenge));
    const proof = { challengeId: c.body.challengeId, publicKeySpki: found.credential.publicKeySpki, signature, keyFingerprint: found.credential.fingerprint };
    const v = await api<{ ok?: boolean; reason?: string }>("verify", proof);
    setLast(proof);
    log(v.body.ok ? "ok" : "bad", `[debug] Server verification: ${v.body.ok ? "valid" : v.body.reason}`);
  }
  async function replay() {
    if (!last) return log("info", "[debug] Sign first.");
    const v = await api<{ ok?: boolean; reason?: string }>("verify", last);
    log(v.body.ok ? "bad" : "ok", v.body.ok ? "[debug] Replay ACCEPTED — not acceptable" : `[debug] Replay refused (${v.body.reason}) ✓`);
  }

  return (
    <details style={card}>
      <summary style={{ fontWeight: 700, cursor: "pointer" }}>Debug: manual crypto checks</summary>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        <button style={btn} onClick={() => void generate()}>Generate Credential</button>
        <button style={btn} onClick={() => void check()}>Load Credential</button>
        <button style={btn} onClick={() => void signVerify()}>Sign Challenge + Verify Signature</button>
        <button style={btn} onClick={() => void replay()}>Replay Last Signature</button>
        <button style={btn} onClick={() => void remove("debug").then(() => log("info", "[debug] Debug key cleared."))}>Clear Debug Key</button>
        <button
          style={{ ...btn, color: PALETTE.bad }}
          onClick={() => void remove("device").then(() => {
            onDeviceCleared();
            log("info", "Enrolled device key deleted from this app: it is now unenrolled (simulates cleared storage).");
          })}
        >
          Delete Enrolled Device Key
        </button>
      </div>
    </details>
  );
}
