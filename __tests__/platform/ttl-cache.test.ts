/**
 * The small time-limited memory behind the chat route's two lookups.
 *
 * What it must never do is serve an answer past its time, or grow without
 * limit. Everything else about it — a lost entry, an eviction — only ever costs
 * one repeated request, which is why it can live in one process's memory at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "../../lib/ttl-cache";

test("a value is served until it expires, and not a moment after", () => {
  const cache = createTtlCache<string>(1_000, 10);
  cache.set("k", "v", 0);
  assert.equal(cache.get("k", 999), "v");
  assert.equal(cache.get("k", 1_000), undefined, "served at its expiry");
});

test("an expired entry is removed when it is read", () => {
  const cache = createTtlCache<string>(1_000, 10);
  cache.set("k", "v", 0);
  cache.get("k", 5_000);
  assert.equal(cache.size, 0);
});

test("at capacity the oldest entry goes, not the newest", () => {
  const cache = createTtlCache<number>(60_000, 3);
  cache.set("a", 1, 0);
  cache.set("b", 2, 0);
  cache.set("c", 3, 0);
  cache.set("d", 4, 0);
  assert.equal(cache.size, 3, "it must not grow past its bound");
  assert.equal(cache.get("a", 0), undefined);
  assert.equal(cache.get("d", 0), 4);
});

test("setting a key again renews it and moves it to the back of the queue", () => {
  const cache = createTtlCache<number>(1_000, 2);
  cache.set("a", 1, 0);
  cache.set("b", 2, 0);
  cache.set("a", 10, 500); // renewed: now the most recent, and good until 1,500
  cache.set("c", 3, 500); // evicts the oldest, which is now b
  assert.equal(cache.get("b", 500), undefined);
  assert.equal(cache.get("a", 1_400), 10);
});

test("clear empties it", () => {
  const cache = createTtlCache<number>(1_000, 10);
  cache.set("a", 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get("a"), undefined);
});
