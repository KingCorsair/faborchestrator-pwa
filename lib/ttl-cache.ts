/**
 * A small, bounded, time-limited memory.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 * Remembering an answer another service gave, for long enough that asking again
 * would be waste and not so long that it could go stale in a way anybody would
 * notice. It is a cache in the plain sense: losing any entry at any moment — a
 * restart, a second copy of the app, an eviction — costs one repeated request
 * and nothing else. That is what makes it safe to keep in one process's memory,
 * and it is exactly the property the sign-in counter does not have, which is
 * why `lib/rate-limit.ts` does not use this.
 *
 * ── Bounded ─────────────────────────────────────────────────────────────────
 * At `maxEntries` the oldest entry is dropped, so a stream of sessions cannot
 * grow it without limit. Expired entries go when they are next read, or when
 * they become the oldest.
 */

export interface TtlCache<V> {
  /** The value, or undefined if it was never set or has expired. */
  get(key: string, now?: number): V | undefined;
  set(key: string, value: V, now?: number): void;
  clear(): void;
  readonly size: number;
}

export function createTtlCache<V>(ttlMs: number, maxEntries: number): TtlCache<V> {
  const entries = new Map<string, { value: V; expires: number }>();

  return {
    get(key, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now >= entry.expires) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },

    set(key, value, now = Date.now()) {
      // Re-inserted rather than updated in place, so the Map's insertion order
      // stays "least recently written first" and eviction drops the right one.
      entries.delete(key);
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, { value, expires: now + ttlMs });
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}
