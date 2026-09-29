// Conflict-safe reads and writes for Netlify Blobs.
//
// A plain "read, change, write" loses updates when two people act at the same moment (e.g. five
// friends open an invite link together). updateJSON() makes each change conditional on the version
// it was based on and simply retries with fresh data when someone else got there first.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function etagOf(store, key) {
  const { blobs } = await store.list({ prefix: key });
  return blobs.find((b) => b.key === key)?.etag;
}

// Returns { data, etag } — data is null when the key doesn't exist.
// `unstable: true` means the value kept changing while we tried to read it: the caller must not
// write based on it (a write without a matching version would silently overwrite other people's changes).
export async function readJSON(store, key) {
  const r = await store.getWithMetadata(key, { type: "json" });
  if (!r) return { data: null, etag: undefined };
  if (r.etag) return { data: r.data, etag: r.etag };
  // Some environments (the local dev sandbox) don't send the version on reads: look it up
  // before and after reading, and only trust the pair if nothing changed in between.
  for (let i = 0; i < 8; i++) {
    const before = await etagOf(store, key);
    const data = await store.get(key, { type: "json" });
    if (data == null) return { data: null, etag: undefined };
    if (before && before === (await etagOf(store, key))) return { data, etag: before };
  }
  return { data: null, etag: undefined, unstable: true };
}

/**
 * Atomically change one JSON value.
 * `mutate(current)` returns the new value, or `undefined` to leave things as they are.
 * It may run more than once, so keep it free of side effects (collect results, don't send them).
 */
export async function updateJSON(store, key, mutate, { retries = 40 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { data, etag, unstable } = await readJSON(store, key);
    if (unstable) { await sleep(8 + Math.random() * Math.min(30 * (attempt + 1), 220)); continue; }
    const next = await mutate(data == null ? null : structuredClone(data));
    if (next === undefined) return { data, changed: false };
    // Never write without a version check: either "matches what I read" or "only if it doesn't exist yet".
    const cond = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const res = await store.setJSON(key, next, cond);
    if (res.modified) return { data: next, changed: true };
    await sleep(8 + Math.random() * Math.min(30 * (attempt + 1), 220)); // back off a little more each time, capped
  }
  throw Object.assign(new Error("Lots of people are changing this at once — please try again"), { status: 409 });
}

// Adds an entry to the front of a capped log without losing anyone else's entries.
export const appendLog = (store, key, entries, cap) =>
  entries.length
    ? updateJSON(store, key, (log) => [...[...entries].reverse(), ...(log || [])].slice(0, cap))
    : undefined;
