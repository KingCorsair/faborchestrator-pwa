/**
 * Two devices, one FabOrchestrator account: are their conversations private
 * inside this app?
 *
 * ── What it proves (1 October 2026) ─────────────────────────────────────────
 * Several people may sign in with the same FabOrchestrator username and
 * password. Each device is its own private session: it sees and uses only the
 * conversations it started (`lib/gateway/seats.ts`). FabOrchestrator is not
 * changed; the rule is this app's gateway's. This script is two cookie jars,
 * "A" and "B", signing in to this app with the **exact same account**, and it
 * checks over the wire that:
 *
 *   · each sees its own conversation in the list and not the other's;
 *   · neither can open, continue, rename, pin, delete, or read or write the
 *     messages of the other's conversation by supplying its id;
 *   · two chat turns sent at the same time land in the right conversations;
 *   · signing A out changes nothing for B;
 *   · A signing in again on the same device gets its conversations back;
 *   · a third device starts empty, and a conversation nobody recorded (one
 *     started on FabOrchestrator's own site) is hidden from all of them.
 *
 * ── It writes, so it is never pointed at an account by default ──────────────
 * It creates conversations in FabOrchestrator, sends two short chat turns
 * (**real model calls** against a real FabOrchestrator), and deletes what it
 * created. The account is named explicitly; nothing is read from `.env`:
 *
 *   APP_URL=http://localhost:3002 \
 *   SEAT_CHECK_EMAIL=… SEAT_CHECK_PASSWORD=… \
 *   node scripts/two-seat-check.mjs
 *
 * Optional:
 *   FO_URL            FabOrchestrator's own origin, **for a local or test
 *                     FabOrchestrator only**. Adds the checks that need a
 *                     second way in: that FabOrchestrator itself still shows
 *                     the account both conversations (so the isolation seen
 *                     here is this app's), that a conversation started there
 *                     is hidden here, and that sign-out revoked the session.
 *                     It signs in to FabOrchestrator directly and reads the
 *                     device's FO token from this script's own cookie jar.
 *   SEAT_CHECK_MODEL  The model id to send (default: FabOrchestrator's).
 *   SEAT_CHECK_CHAT=0 Skip the two chat turns (no model calls).
 *
 * One thing it reports rather than asserts, because this app cannot tie it to
 * a device (see `lib/gateway/seats.ts`): feedback on a message, which names a
 * message id. It is printed as NOTE lines and is not counted.
 */

const APP = (process.env.APP_URL ?? "http://localhost:3002").replace(/\/$/, "");
const FO = process.env.FO_URL ? process.env.FO_URL.replace(/\/$/, "") : null;
const EMAIL = process.env.SEAT_CHECK_EMAIL;
const PASSWORD = process.env.SEAT_CHECK_PASSWORD;
const MODEL = process.env.SEAT_CHECK_MODEL || undefined;
const WITH_CHAT = process.env.SEAT_CHECK_CHAT !== "0";
/** The device cookie's name: `__Host-` on a deployment, the plain name on loopback http (`lib/faborch/device.ts`). */
const SEAT_COOKIE = APP.startsWith("https:") ? "__Host-faborch_seat" : "faborch_seat";

if (!EMAIL || !PASSWORD) {
  console.error("\n  Set SEAT_CHECK_EMAIL and SEAT_CHECK_PASSWORD: the one account both devices sign in with.\n");
  process.exit(2);
}

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const skip = (name, why) => console.log(`  SKIP  ${name}  — ${why}`);
const note = (text) => console.log(`  NOTE  ${text}`);
const section = (title) => console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
const refused = (status) => status === 403 || status === 404;
const tag = Math.random().toString(36).slice(2, 8).toUpperCase();

/** One browser: its own cookies (path-aware, as a browser is) and its own bearer. */
class Device {
  constructor(name) {
    this.name = name;
    this.jar = new Map(); // name → { value, path, httpOnly }
    this.bearer = null;
  }
  store(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const path = attrs.find((a) => /^path=/i.test(a))?.slice(5) ?? "/";
      const maxAge = attrs.find((a) => /^max-age=/i.test(a))?.slice(8);
      if (value === "" || maxAge === "0") this.jar.delete(name);
      else this.jar.set(name, { value, path, httpOnly: attrs.some((a) => /^httponly$/i.test(a)) });
    }
  }
  cookieHeader(path) {
    return [...this.jar]
      .filter(([, c]) => path === c.path || path.startsWith(c.path.endsWith("/") ? c.path : c.path + "/"))
      .map(([n, c]) => `${n}=${c.value}`)
      .join("; ");
  }
  cookie(name) {
    return this.jar.get(name)?.value ?? null;
  }
  /** The seat signed into this device's session (the token's payload is readable, not secret). */
  seat() {
    try {
      return JSON.parse(Buffer.from(this.bearer.split(".")[0], "base64url").toString("utf8")).sid ?? null;
    } catch {
      return null;
    }
  }
  async signIn() {
    const path = "/api/pwa/auth/login";
    const res = await fetch(`${APP}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP, cookie: this.cookieHeader(path) },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    this.store(res);
    const body = await res.json().catch(() => ({}));
    this.bearer = body.token ?? null;
    return { status: res.status, body };
  }
  async signOut() {
    const path = "/api/pwa/auth/logout";
    const res = await fetch(`${APP}${path}`, {
      method: "POST",
      headers: { origin: APP, cookie: this.cookieHeader(path) },
    });
    this.store(res);
    return res.status;
  }
  /** A FabOrchestrator API call through this app's gateway, as FO's own client makes it. */
  call(method, path, body) {
    return fetch(`${APP}${path}`, {
      method,
      headers: {
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        cookie: this.cookieHeader(path.split("?")[0]),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
  async json(method, path, body) {
    const res = await this.call(method, path, body);
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON: the status is the answer */
    }
    return { status: res.status, data, text };
  }
  async listIds() {
    const { status, data } = await this.json("GET", "/api/conversations");
    const rows = Array.isArray(data) ? data : (data?.conversations ?? []);
    return { status, ids: rows.map((r) => r.id) };
  }
  async create(title) {
    const { status, data } = await this.json("POST", "/api/conversations", { title, ...(MODEL ? { model: MODEL } : {}) });
    return { status, id: data?.id ?? null };
  }
}

/** A call made straight to FabOrchestrator with a FabOrchestrator token (FO_URL only). */
async function direct(token, method, path, body) {
  const res = await fetch(`${FO}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* the status is the answer */
  }
  return { status: res.status, data, text };
}

const chatBody = (conversationId, text) => ({
  messages: [{ id: `m-${Math.random().toString(36).slice(2)}`, role: "user", parts: [{ type: "text", text }] }],
  ...(MODEL ? { model: MODEL } : {}),
  conversationId,
  enableReasoning: false,
  webSearch: false,
  activeMcpIds: [],
});

/**
 * Send one turn and read the answer to its end. Returns the status, the raw
 * stream, and the answer's text put back together from the stream's
 * `text-delta` frames (a word arrives in pieces, so the raw text never holds it whole).
 */
async function turn(device, conversationId, text) {
  const res = await device.call("POST", "/api/chat", chatBody(conversationId, text));
  const stream = await res.text();
  let answer = "";
  for (const line of stream.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    try {
      const frame = JSON.parse(line.slice(6));
      if (frame.type === "text-delta" && typeof frame.delta === "string") answer += frame.delta;
    } catch {
      /* `[DONE]` and anything else that is not a frame */
    }
  }
  return { status: res.status, stream, answer };
}

/** The saved messages of a conversation, waiting briefly for the answer FO writes when its stream ends. */
async function savedMessages(device, id, wantAssistant) {
  for (let i = 0; i < 40; i += 1) {
    const { status, data } = await device.json("GET", `/api/conversations/${id}`);
    const messages = data?.messages ?? [];
    if (status !== 200 || !wantAssistant || messages.some((m) => m.role === "assistant")) return { status, messages };
    await new Promise((r) => setTimeout(r, 500));
  }
  const { status, data } = await device.json("GET", `/api/conversations/${id}`);
  return { status, messages: data?.messages ?? [] };
}
const textOf = (m) =>
  [m.content ?? "", ...(m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "")].join(" ");

console.log(`\ntwo seats, one account · ${APP}${FO ? `  (FabOrchestrator, direct: ${FO})` : ""}\n`);

const A = new Device("A");
const B = new Device("B");
const created = []; // [device, conversationId] to delete at the end
let legacyId = null;
let webToken = null;

try {
  /* ── 1. two devices, the exact same account ───────────────────────────── */
  section("1. two devices sign in with the exact same account");
  const inA = await A.signIn();
  const inB = await B.signIn();
  ok("A signs in", inA.status === 200, `HTTP ${inA.status}`);
  ok("B signs in with the same email and password", inB.status === 200, `HTTP ${inB.status}`);
  if (inA.status !== 200 || inB.status !== 200) throw new Error("sign-in failed; nothing else can be checked");
  ok("both are the same FabOrchestrator user", inA.body.user?.id && inA.body.user.id === inB.body.user?.id);
  ok("each device was given a device key", !!A.cookie(SEAT_COOKIE) && !!B.cookie(SEAT_COOKIE));
  ok("…and they differ", A.cookie(SEAT_COOKIE) !== B.cookie(SEAT_COOKIE));
  ok("…httpOnly, at Path=/", A.jar.get(SEAT_COOKIE)?.httpOnly && A.jar.get(SEAT_COOKIE)?.path === "/");
  ok("each session carries a seat, and the two seats differ", !!A.seat() && !!B.seat() && A.seat() !== B.seat());
  ok("the seat is not the device key", A.seat() !== A.cookie(SEAT_COOKIE));
  ok("each login has its own FabOrchestrator session", A.cookie("faborch_token") !== B.cookie("faborch_token"));
  const deviceKeyA = A.cookie(SEAT_COOKIE);
  const seatA = A.seat();

  /* ── 2. each creates a conversation ───────────────────────────────────── */
  section("2. A creates A1, B creates B1");
  const a1 = await A.create(`A1 seat-check ${tag}`);
  const b1 = await B.create(`B1 seat-check ${tag}`);
  ok("A creates A1", a1.status === 201 && !!a1.id, `HTTP ${a1.status}`);
  ok("B creates B1", b1.status === 201 && !!b1.id, `HTTP ${b1.status}`);
  if (!a1.id || !b1.id) throw new Error("could not create the conversations");
  created.push([A, a1.id], [B, b1.id]);
  const A1 = a1.id;
  const B1 = b1.id;

  /* ── 3. the lists ─────────────────────────────────────────────────────── */
  section("3. each sees its own conversation and not the other's");
  let listA = await A.listIds();
  let listB = await B.listIds();
  ok("A's list has A1", listA.ids.includes(A1));
  ok("A's list does not have B1", listA.status === 200 && !listA.ids.includes(B1));
  ok("B's list has B1", listB.ids.includes(B1));
  ok("B's list does not have A1", listB.status === 200 && !listB.ids.includes(A1));

  /* ── 4. by id ─────────────────────────────────────────────────────────── */
  section("4. neither can open the other's conversation by its id");
  const getAB = await A.json("GET", `/api/conversations/${B1}`);
  const getBA = await B.json("GET", `/api/conversations/${A1}`);
  ok("A GET B1 is refused", refused(getAB.status), `HTTP ${getAB.status} ${getAB.data?.code ?? ""}`);
  ok("B GET A1 is refused", refused(getBA.status), `HTTP ${getBA.status} ${getBA.data?.code ?? ""}`);
  ok("…and the refusal carries no title", !getAB.text.includes("B1 seat-check") && !getBA.text.includes("A1 seat-check"));
  ok("A GET A1 works", (await A.json("GET", `/api/conversations/${A1}`)).status === 200);
  ok("B GET B1 works", (await B.json("GET", `/api/conversations/${B1}`)).status === 200);
  const msgAB = await A.json("GET", `/api/conversations/${B1}/messages`);
  const msgBA = await B.json("GET", `/api/conversations/${A1}/messages`);
  ok("A cannot read B1's messages", refused(msgAB.status), `HTTP ${msgAB.status}`);
  ok("B cannot read A1's messages", refused(msgBA.status), `HTTP ${msgBA.status}`);

  /* ── 5. concurrent chat ───────────────────────────────────────────────── */
  let answerB = null;
  if (WITH_CHAT) {
    section("5. two turns at the same time land in the right conversations");
    const wordA = `ALPHA${tag}`;
    const wordB = `BRAVO${tag}`;
    const [tA, tB] = await Promise.all([
      turn(A, A1, `Reply with exactly this one word and nothing else: ${wordA}`),
      turn(B, B1, `Reply with exactly this one word and nothing else: ${wordB}`),
    ]);
    ok("A's turn is answered", tA.status === 200, `HTTP ${tA.status}${tA.status === 200 ? "" : " " + tA.stream.slice(0, 120)}`);
    ok("B's turn is answered", tB.status === 200, `HTTP ${tB.status}${tB.status === 200 ? "" : " " + tB.stream.slice(0, 120)}`);
    ok("the answer A received carries A's word and not B's", tA.answer.includes(wordA) && !tA.answer.includes(wordB), JSON.stringify(tA.answer.slice(0, 40)));
    ok("the answer B received carries B's word and not A's", tB.answer.includes(wordB) && !tB.answer.includes(wordA), JSON.stringify(tB.answer.slice(0, 40)));

    const savedA = await savedMessages(A, A1, true);
    const savedB = await savedMessages(B, B1, true);
    const allA = savedA.messages.map(textOf).join(" | ");
    const allB = savedB.messages.map(textOf).join(" | ");
    ok("A1 holds A's question and an answer", allA.includes(wordA) && savedA.messages.some((m) => m.role === "assistant"), `${savedA.messages.length} messages`);
    ok("A1 holds nothing of B's", !allA.includes(wordB));
    ok("B1 holds B's question and an answer", allB.includes(wordB) && savedB.messages.some((m) => m.role === "assistant"), `${savedB.messages.length} messages`);
    ok("B1 holds nothing of A's", !allB.includes(wordA));
    answerB = savedB.messages.find((m) => m.role === "assistant") ?? null;
  } else {
    section("5. concurrent chat");
    skip("two turns at the same time", "SEAT_CHECK_CHAT=0");
  }

  /* ── 6. continuing the other's conversation ───────────────────────────── */
  section("6. neither can continue the other's conversation");
  const before = (await savedMessages(B, B1, false)).messages.length;
  const beforeA = (await savedMessages(A, A1, false)).messages.length;
  const contAB = await A.json("POST", "/api/chat", chatBody(B1, `INTRUDER${tag} from A`));
  const contBA = await B.json("POST", "/api/chat", chatBody(A1, `INTRUDER${tag} from B`));
  const contModel = await A.json("POST", "/api/modeling-agent/chat", chatBody(B1, `INTRUDER${tag} modeling`));
  ok("A's turn naming B1 is refused", refused(contAB.status), `HTTP ${contAB.status} ${contAB.data?.code ?? ""}`);
  ok("B's turn naming A1 is refused", refused(contBA.status), `HTTP ${contBA.status} ${contBA.data?.code ?? ""}`);
  ok("A's modeling-agent turn naming B1 is refused", refused(contModel.status), `HTTP ${contModel.status} ${contModel.data?.code ?? ""}`);
  const postAB = await A.json("POST", `/api/conversations/${B1}/messages`, { role: "user", content: `INTRUDER${tag} direct write` });
  ok("A cannot write a message into B1", refused(postAB.status), `HTTP ${postAB.status}`);
  const wipeAB = await A.json("DELETE", `/api/conversations/${B1}/messages`);
  ok("A cannot clear B1's messages", refused(wipeAB.status), `HTTP ${wipeAB.status}`);
  const afterB = await savedMessages(B, B1, false);
  const afterA = await savedMessages(A, A1, false);
  ok("B1 is unchanged", afterB.messages.length === before && !afterB.messages.map(textOf).join(" ").includes("INTRUDER"), `${afterB.messages.length} messages`);
  ok("A1 is unchanged", afterA.messages.length === beforeA && !afterA.messages.map(textOf).join(" ").includes("INTRUDER"), `${afterA.messages.length} messages`);

  /* ── 7. rename, pin, delete ───────────────────────────────────────────── */
  section("7. neither can rename, pin or delete the other's conversation");
  const renAB = await A.json("PATCH", `/api/conversations/${B1}`, { title: `HIJACKED${tag}` });
  const pinBA = await B.json("PATCH", `/api/conversations/${A1}`, { isPinned: true, title: `HIJACKED${tag}` });
  const titleAB = await A.json("POST", `/api/conversations/${B1}/title`, { message: "rename me" });
  const delAB = await A.json("DELETE", `/api/conversations/${B1}`);
  const delBA = await B.json("DELETE", `/api/conversations/${A1}`);
  ok("A PATCH B1 is refused", refused(renAB.status), `HTTP ${renAB.status}`);
  ok("B PATCH A1 is refused", refused(pinBA.status), `HTTP ${pinBA.status}`);
  ok("A cannot regenerate B1's title", refused(titleAB.status), `HTTP ${titleAB.status}`);
  ok("A DELETE B1 is refused", refused(delAB.status), `HTTP ${delAB.status}`);
  ok("B DELETE A1 is refused", refused(delBA.status), `HTTP ${delBA.status}`);
  const stillB = await B.json("GET", `/api/conversations/${B1}`);
  const stillA = await A.json("GET", `/api/conversations/${A1}`);
  ok("B1 still exists with its own title", stillB.status === 200 && stillB.data?.title === `B1 seat-check ${tag}`, stillB.data?.title);
  ok("A1 still exists, unpinned, with its own title", stillA.status === 200 && stillA.data?.title === `A1 seat-check ${tag}` && stillA.data?.isPinned === false, stillA.data?.title);
  const ownRename = await A.json("PATCH", `/api/conversations/${A1}`, { title: `A1 renamed ${tag}` });
  ok("A can rename its own A1", ownRename.status === 200 && ownRename.data?.title === `A1 renamed ${tag}`, `HTTP ${ownRename.status}`);

  /* ── 8. artifacts, and what is not tied to a device ───────────────────── */
  section("8. artifacts are closed; feedback is by message id");
  const artA = await A.json("GET", `/api/artifacts?conversationId=${B1}`);
  const artB = await B.json("GET", `/api/artifacts?conversationId=${B1}`);
  ok("A cannot list B1's artifacts", refused(artA.status), `HTTP ${artA.status}`);
  ok("the artifacts route is closed for everybody, the owner included", artB.status === 404, `HTTP ${artB.status}`);
  if (answerB) {
    const own = await B.json("POST", "/api/messages/feedback", { messageId: answerB.id, feedback: "positive" });
    ok("B's feedback on its own answer is accepted", own.status === 200, `HTTP ${own.status}`);
    note("feedback names a message id, not a conversation, so this app cannot tie it to a device;");
    note("a message id is random and reaches a browser only inside a conversation its seat owns.");
  } else {
    skip("feedback on the device's own answer", "needs the saved answer from step 5");
  }

  /* ── 9. what FabOrchestrator itself does, and what was started there ──── */
  section("9. FabOrchestrator is unchanged: the separation is this app's");
  if (FO) {
    const dList = await direct(A.cookie("faborch_token"), "GET", "/api/conversations");
    const ids = (dList.data ?? []).map((r) => r.id);
    ok("FabOrchestrator itself still shows the account both A1 and B1", dList.status === 200 && ids.includes(A1) && ids.includes(B1), `${ids.length} conversations for the user`);

    const web = await fetch(`${FO}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }).then((r) => r.json());
    webToken = web.token;
    const legacy = await direct(webToken, "POST", "/api/conversations", { title: `W1 started on the FO site ${tag}` });
    legacyId = legacy.data?.id ?? null;
    ok("a conversation is started on FabOrchestrator's own site", legacy.status === 201 && !!legacyId);
    const seenA = await A.listIds();
    const seenB = await B.listIds();
    ok("it is in neither device's list here", !seenA.ids.includes(legacyId) && !seenB.ids.includes(legacyId));
    ok("…and neither device can open it by id", refused((await A.json("GET", `/api/conversations/${legacyId}`)).status) && refused((await B.json("GET", `/api/conversations/${legacyId}`)).status));
    const legacyTurn = await A.json("POST", "/api/chat", chatBody(legacyId, `INTRUDER${tag} into a conversation nobody recorded`));
    ok("…or continue it", refused(legacyTurn.status), `HTTP ${legacyTurn.status} ${legacyTurn.data?.code ?? ""}`);
    const legacyAfter = await direct(webToken, "GET", `/api/conversations/${legacyId}`);
    ok("…and it is untouched in FabOrchestrator", legacyAfter.status === 200 && (legacyAfter.data?.messages ?? []).length === 0);
  } else {
    skip("checks that need a second way into FabOrchestrator", "FO_URL not set");
  }

  /* ── 10. A signs out ──────────────────────────────────────────────────── */
  section("10. signing A out does not affect B");
  const oldTokenA = A.cookie("faborch_token");
  const oldBearerA = A.bearer;
  const out = await A.signOut();
  ok("A signs out", out === 200, `HTTP ${out}`);
  ok("A's session cookie is gone, its device key is kept", !A.cookie("faborch_token") && A.cookie(SEAT_COOKIE) === deviceKeyA);
  const deadA = await A.json("GET", "/api/conversations");
  ok("A's old session opens nothing", deadA.status === 401, `HTTP ${deadA.status}`);
  if (FO) {
    await new Promise((r) => setTimeout(r, 1500)); // the revoke runs after the response
    const revoked = await direct(oldTokenA, "GET", "/api/conversations");
    ok("…and FabOrchestrator has ended A's session", revoked.status === 401, `HTTP ${revoked.status}`);
  }
  listB = await B.listIds();
  ok("B still works", listB.status === 200, `HTTP ${listB.status}`);
  ok("B still sees B1 and not A1", listB.ids.includes(B1) && !listB.ids.includes(A1));
  ok("B can still open B1", (await B.json("GET", `/api/conversations/${B1}`)).status === 200);

  /* ── 11. A signs in again on the same device ──────────────────────────── */
  section("11. A signs in again on the same device and gets its conversations back");
  const again = await A.signIn();
  ok("A signs in again", again.status === 200, `HTTP ${again.status}`);
  ok("…on the same device key, so the same seat", A.cookie(SEAT_COOKIE) === deviceKeyA && A.seat() === seatA);
  ok("…with a new session", A.cookie("faborch_token") !== oldTokenA && A.bearer !== oldBearerA);
  listA = await A.listIds();
  ok("A sees A1 again", listA.ids.includes(A1));
  ok("A still does not see B1", listA.status === 200 && !listA.ids.includes(B1));
  ok("A can open A1", (await A.json("GET", `/api/conversations/${A1}`)).status === 200);
  ok("A still cannot open B1", refused((await A.json("GET", `/api/conversations/${B1}`)).status));

  /* ── 12. a third device ───────────────────────────────────────────────── */
  section("12. a third device on the same account starts empty");
  const C = new Device("C");
  const inC = await C.signIn();
  const listC = await C.listIds();
  ok("C signs in with the same account", inC.status === 200);
  ok("C sees neither A1 nor B1", listC.status === 200 && !listC.ids.includes(A1) && !listC.ids.includes(B1), `${listC.ids.length} conversations`);
  ok("C cannot open A1 or B1 by id", refused((await C.json("GET", `/api/conversations/${A1}`)).status) && refused((await C.json("GET", `/api/conversations/${B1}`)).status));
  await C.signOut();
  ok("C signing out leaves A and B working", (await A.listIds()).status === 200 && (await B.listIds()).status === 200);
} catch (error) {
  ok("the run completed", false, error instanceof Error ? error.message : String(error));
} finally {
  /* ── clean up what this run created ─────────────────────────────────────── */
  section("clean up");
  for (const [device, id] of created) {
    const res = await device.json("DELETE", `/api/conversations/${id}`).catch(() => ({ status: 0 }));
    console.log(`  ${res.status === 200 ? "ok  " : "LEFT"}  ${device.name} deletes its conversation ${id.slice(0, 8)}…  HTTP ${res.status}`);
  }
  if (FO && webToken) {
    if (legacyId) await direct(webToken, "DELETE", `/api/conversations/${legacyId}`).catch(() => {});
    await direct(webToken, "POST", "/api/auth/logout").catch(() => {});
  }
  await A.signOut().catch(() => {});
  await B.signOut().catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? "  ·  FAILED: " + failed.map((f) => f.name).join("; ") : ""}\n`);
if (failed.length) process.exitCode = 1;
