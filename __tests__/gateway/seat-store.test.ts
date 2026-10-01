/**
 * The seat store (`lib/gateway/seat-store.ts`): which device started which
 * conversation, for the PWA-side conversation isolation of 1 October 2026.
 *
 * What these pin is the list of things the store must never do:
 *   · treat a conversation with no valid record as anybody's;
 *   · say a claim succeeded before it is on disk;
 *   · lose one of two claims made at the same instant;
 *   · let a corrupt, torn or altered record grant anything;
 *   · hand a conversation from one seat to another;
 *   · forget across a restart.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isConversationId,
  isSeatId,
  parseRecord,
  resetSeatStores,
  SeatStore,
  seatStore,
  SeatStoreUnavailableError,
  serializeRecord,
} from "@/lib/gateway/seat-store";

const seatId = () => randomBytes(32).toString("base64url");
const SEAT_A = seatId();
const SEAT_B = seatId();

let dir = "";
let path = "";
const opened: SeatStore[] = [];
const realConsoleError = console.error;

/** A store on this test's file; closed afterwards. A second call is "after a restart". */
function open(file = path): SeatStore {
  const store = new SeatStore(file);
  opened.push(store);
  return store;
}
const linesOf = async (file = path) => (await readFile(file, "utf8")).split("\n").filter((l) => l !== "");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seat-store-"));
  path = join(dir, "nested", "conversations.log");
  console.error = () => {};
});
afterEach(async () => {
  console.error = realConsoleError;
  await Promise.all(opened.splice(0).map((s) => s.close().catch(() => undefined)));
  await resetSeatStores();
  await rm(dir, { recursive: true, force: true });
});

describe("an unmapped conversation is nobody's", () => {
  test("with no file at all", async () => {
    const store = open();
    const id = randomUUID();
    assert.equal(await store.ownerOf(id), null);
    assert.equal(await store.isOwnedBy(id, SEAT_A), false);
    assert.equal(await store.isOwnedBy(id, SEAT_B), false);
  });

  test("beside conversations that are mapped", async () => {
    const store = open();
    await store.claim(randomUUID(), SEAT_A);
    assert.equal(await store.isOwnedBy(randomUUID(), SEAT_A), false, "another id is not A's because A owns something");
  });

  test("and something that is not a conversation id is nobody's either", async () => {
    const store = open();
    for (const id of ["", "not-a-uuid", "../../etc/passwd", `${randomUUID()} `, randomUUID().toUpperCase() + "x"]) {
      assert.equal(await store.ownerOf(id), null);
      assert.equal(await store.isOwnedBy(id, SEAT_A), false);
    }
  });
});

describe("a claim", () => {
  test("makes the conversation the claiming seat's, and nobody else's", async () => {
    const store = open();
    const id = randomUUID();
    assert.equal(await store.claim(id, SEAT_A), "claimed");
    assert.equal(await store.ownerOf(id), SEAT_A);
    assert.equal(await store.isOwnedBy(id, SEAT_A), true);
    assert.equal(await store.isOwnedBy(id, SEAT_B), false);
  });

  test("is on disk, as one validated line, by the time it resolves", async () => {
    const store = open();
    const id = randomUUID();
    await store.claim(id, SEAT_A, 1_759_000_000_000);
    const lines = await linesOf();
    assert.equal(lines.length, 1);
    assert.deepEqual(parseRecord(lines[0]!), { id, seat: SEAT_A, at: 1_759_000_000_000 });
    assert.ok((await readFile(path, "utf8")).endsWith("\n"));
  });

  test("again by the same seat changes nothing and writes nothing", async () => {
    const store = open();
    const id = randomUUID();
    await store.claim(id, SEAT_A);
    assert.equal(await store.claim(id, SEAT_A), "already-own");
    assert.equal((await linesOf()).length, 1);
  });

  test("by another seat is refused: the first owner is the only owner", async () => {
    const store = open();
    const id = randomUUID();
    await store.claim(id, SEAT_A);
    assert.equal(await store.claim(id, SEAT_B), "conflict");
    assert.equal(await store.ownerOf(id), SEAT_A);
    assert.equal(await store.isOwnedBy(id, SEAT_B), false);
    assert.equal((await linesOf()).length, 1, "the refused claim wrote nothing");
  });

  test("for something that is not a conversation id, or not a seat, is rejected", async () => {
    const store = open();
    await assert.rejects(store.claim("not-a-uuid", SEAT_A), TypeError);
    await assert.rejects(store.claim(randomUUID(), "not-a-seat"), TypeError);
    await assert.rejects(store.claim(randomUUID(), ""), TypeError);
    assert.deepEqual(await store.stats(), { owned: 0, conflicted: 0, corrupt: 0 });
  });
});

describe("concurrent claims are serialised, and none is lost", () => {
  test("two hundred conversations created at once by two seats", async () => {
    const store = open();
    const claims = Array.from({ length: 200 }, (_, i) => ({ id: randomUUID(), seat: i % 2 ? SEAT_B : SEAT_A }));
    const results = await Promise.all(claims.map((c) => store.claim(c.id, c.seat)));
    assert.ok(results.every((r) => r === "claimed"));

    const lines = await linesOf();
    assert.equal(lines.length, 200, "one whole line per claim");
    const parsed = lines.map(parseRecord);
    assert.ok(parsed.every(Boolean), "no line is interleaved with another");
    assert.deepEqual(
      new Set(parsed.map((r) => r!.id)),
      new Set(claims.map((c) => c.id)),
    );

    const restarted = open();
    for (const c of claims) assert.equal(await restarted.ownerOf(c.id), c.seat);
    assert.deepEqual(await restarted.stats(), { owned: 200, conflicted: 0, corrupt: 0 });
  });

  test("two seats claiming the same new conversation at once: exactly one gets it", async () => {
    const store = open();
    const id = randomUUID();
    const results = await Promise.all([store.claim(id, SEAT_A), store.claim(id, SEAT_B)]);
    assert.deepEqual([...results].sort(), ["claimed", "conflict"]);
    assert.equal((await linesOf()).length, 1);
    const winner = results[0] === "claimed" ? SEAT_A : SEAT_B;
    assert.equal(await store.ownerOf(id), winner);
    assert.equal(await open().ownerOf(id), winner, "and the same after a restart");
  });

  test("the same seat claiming one conversation fifty times at once writes it once", async () => {
    const store = open();
    const id = randomUUID();
    const results = await Promise.all(Array.from({ length: 50 }, () => store.claim(id, SEAT_A)));
    assert.equal(results.filter((r) => r === "claimed").length, 1);
    assert.equal(results.filter((r) => r === "already-own").length, 49);
    assert.equal((await linesOf()).length, 1);
  });

  test("claims and reads interleaved never see a conversation that is not yet on disk", async () => {
    const store = open();
    const ids = Array.from({ length: 40 }, () => randomUUID());
    await Promise.all(
      ids.map(async (id) => {
        const claim = store.claim(id, SEAT_A);
        await claim;
        // The moment the claim resolves, the line must already be in the file.
        const text = await readFile(path, "utf8");
        assert.ok(text.includes(id), "resolved before it was stored");
        assert.equal(await store.ownerOf(id), SEAT_A);
      }),
    );
  });
});

describe("a restart", () => {
  test("keeps every claim", async () => {
    const first = open();
    const a = randomUUID();
    const b = randomUUID();
    await first.claim(a, SEAT_A);
    await first.claim(b, SEAT_B);
    await first.close();

    const second = open();
    assert.equal(await second.ownerOf(a), SEAT_A);
    assert.equal(await second.ownerOf(b), SEAT_B);
    assert.equal(await second.isOwnedBy(a, SEAT_B), false);
    assert.equal(await second.claim(a, SEAT_B), "conflict", "still nobody else's after a restart");
  });

  test("appends after what was there, never over it", async () => {
    const first = open();
    const a = randomUUID();
    await first.claim(a, SEAT_A);
    await first.close();
    const second = open();
    const b = randomUUID();
    await second.claim(b, SEAT_B);
    const lines = await linesOf();
    assert.equal(lines.length, 2);
    assert.equal(parseRecord(lines[0]!)!.id, a);
    assert.equal(parseRecord(lines[1]!)!.id, b);
  });
});

describe("a malformed or corrupt record grants nothing", () => {
  test("each kind of bad line is ignored, counted, and leaves its conversation unmapped", async () => {
    const good = randomUUID();
    const tampered = randomUUID();
    const wrongVersion = randomUUID();
    const extraField = randomUUID();
    const torn = randomUUID();
    const at = 1_759_000_000_000;

    const tamperedLine = serializeRecord(tampered, SEAT_A, at).replace(SEAT_A, SEAT_B); // seat altered, checksum not
    const wrongVersionLine = serializeRecord(wrongVersion, SEAT_A, at).replace('"v":1', '"v":2');
    const extraFieldLine = serializeRecord(extraField, SEAT_A, at).replace("}", ',"admin":true}');
    const badIdLine = JSON.stringify({ v: 1, id: "not-a-uuid", seat: SEAT_A, at, h: "0".repeat(32) });
    const tornLine = serializeRecord(torn, SEAT_A, at).slice(0, 60); // cut off mid-record, no newline

    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(
      path,
      [
        serializeRecord(good, SEAT_A, at),
        "this is not json",
        tamperedLine,
        wrongVersionLine,
        extraFieldLine,
        badIdLine,
        "[]",
        "null",
        tornLine,
      ].join("\n"),
    );

    const store = open();
    assert.equal(await store.ownerOf(good), SEAT_A, "the valid record still counts");
    for (const id of [tampered, wrongVersion, extraField, torn]) {
      assert.equal(await store.ownerOf(id), null);
      assert.equal(await store.isOwnedBy(id, SEAT_A), false);
      assert.equal(await store.isOwnedBy(id, SEAT_B), false, "an altered seat does not become the owner either");
    }
    assert.deepEqual(await store.stats(), { owned: 1, conflicted: 0, corrupt: 8 });
  });

  test("a torn last line does not swallow the next claim", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "nested"), { recursive: true });
    const before = randomUUID();
    await writeFile(path, `${serializeRecord(before, SEAT_A, 1)}\n${serializeRecord(randomUUID(), SEAT_A, 2).slice(0, 40)}`);

    const store = open();
    const fresh = randomUUID();
    assert.equal(await store.claim(fresh, SEAT_B), "claimed");

    const restarted = open();
    assert.equal(await restarted.ownerOf(fresh), SEAT_B, "the new record is a line of its own");
    assert.equal(await restarted.ownerOf(before), SEAT_A);
    assert.deepEqual(await restarted.stats(), { owned: 2, conflicted: 0, corrupt: 1 });
  });

  test("two valid records giving one conversation to two seats leave it with neither", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "nested"), { recursive: true });
    const id = randomUUID();
    const other = randomUUID();
    await writeFile(
      path,
      `${serializeRecord(id, SEAT_A, 1)}\n${serializeRecord(other, SEAT_B, 2)}\n${serializeRecord(id, SEAT_B, 3)}\n${serializeRecord(id, SEAT_A, 4)}\n`,
    );
    const store = open();
    assert.equal(await store.ownerOf(id), null);
    assert.equal(await store.isOwnedBy(id, SEAT_A), false);
    assert.equal(await store.isOwnedBy(id, SEAT_B), false);
    assert.equal(await store.claim(id, SEAT_A), "conflict", "and it cannot be claimed back");
    assert.equal(await store.ownerOf(other), SEAT_B, "an unrelated conversation is unaffected");
    assert.deepEqual(await store.stats(), { owned: 1, conflicted: 1, corrupt: 0 });
  });

  test("a record is exactly its five fields, with a checksum over them", () => {
    const id = randomUUID();
    const line = serializeRecord(id, SEAT_A, 42);
    assert.deepEqual(parseRecord(line), { id, seat: SEAT_A, at: 42 });
    assert.equal(parseRecord(line.replace(id, randomUUID())), null, "another id does not verify");
    assert.equal(parseRecord(line.replace('"at":42', '"at":43')), null, "another time does not verify");
    assert.equal(parseRecord(line.slice(0, -2)), null);
    assert.equal(parseRecord(""), null);
    assert.equal(isConversationId(id), true);
    assert.equal(isSeatId(SEAT_A), true);
    assert.equal(isSeatId("short"), false);
  });
});

describe("a store that cannot be written or read fails closed", () => {
  test("a claim that could not be stored is rejected, and the conversation stays nobody's", async () => {
    // The store's directory cannot exist: its parent is a file.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x");
    const store = open(join(blocker, "sub", "conversations.log"));
    const id = randomUUID();
    await assert.rejects(store.claim(id, SEAT_A), SeatStoreUnavailableError);
    const owned = await store.isOwnedBy(id, SEAT_A).catch(() => false);
    assert.equal(owned, false, "an unstored claim is never believed");
  });

  test("a failed claim does not hold up the ones after it", async () => {
    const store = open();
    await assert.rejects(store.claim("not-a-uuid", SEAT_A));
    const id = randomUUID();
    assert.equal(await store.claim(id, SEAT_A), "claimed");
  });

  test("a file that cannot be read makes every answer an error, not a guess", async () => {
    // A directory where the file should be.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { recursive: true });
    const store = open();
    await assert.rejects(store.ownerOf(randomUUID()), SeatStoreUnavailableError);
    await assert.rejects(store.isOwnedBy(randomUUID(), SEAT_A), SeatStoreUnavailableError);
    await assert.rejects(store.claim(randomUUID(), SEAT_A), SeatStoreUnavailableError);
    await assert.rejects(store.stats(), SeatStoreUnavailableError);
  });
});

describe("the configured store", () => {
  test("with no path there is no store, and no in-memory stand-in", () => {
    assert.throws(() => seatStore({}), SeatStoreUnavailableError);
    assert.throws(() => seatStore({ SEAT_STORE_PATH: "   " }), SeatStoreUnavailableError);
  });

  test("one store per file, however many times it is asked for", async () => {
    const a = seatStore({ SEAT_STORE_PATH: path });
    const b = seatStore({ SEAT_STORE_PATH: ` ${path} ` });
    assert.equal(a, b);
    const id = randomUUID();
    await a.claim(id, SEAT_A);
    assert.equal(await b.ownerOf(id), SEAT_A);
  });
});
