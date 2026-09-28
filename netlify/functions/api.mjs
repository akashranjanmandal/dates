import { getStore } from "@netlify/blobs";
import {
  authConfigured, checkAdmin, checkPassword, eventsKey, hashPassword, nameKey, sign, userKey, validName, verify,
} from "../shared/auth.mjs";
import { mailConfigured } from "../shared/mail.mjs";
import { pushConfigured, validSubscription, vapidPublicKey } from "../shared/push.mjs";
import { normRemind, remindKey, tzName, validTz } from "../shared/schedule.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = new Set(["birthday", "anniversary", "event", "other"]);

function clean(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date || "") || !String(ev.title || "").trim()) return null;
  return {
    id: String(ev.id || crypto.randomUUID()).slice(0, 64),
    type: TYPES.has(ev.type) ? ev.type : "other",
    title: String(ev.title).trim().slice(0, 120),
    date: ev.date,
    yearUnknown: Boolean(ev.yearUnknown),
    time: /^\d{2}:\d{2}$/.test(ev.time || "") ? ev.time : "",
    repeat: ev.repeat === "yearly" ? "yearly" : "once",
    remind: [...new Map((Array.isArray(ev.remind) ? ev.remind : []).map(normRemind).filter(Boolean).map((r) => [remindKey(r), r])).values()].slice(0, 6),
    notes: String(ev.notes || "").slice(0, 1000),
    updated: Number(ev.updated) || Date.now(),
  };
}

const publicUser = (u) => ({
  name: u.name, email: u.email || "", tz: u.tz || tzName(),
  devices: (u.push || []).length, lastDelivery: u.lastDelivery || null,
});
const sameEvent = (a, b) => JSON.stringify({ ...a, updated: 0 }) === JSON.stringify({ ...b, updated: 0 });

async function logActivity(store, entries) {
  if (!entries.length) return;
  const log = (await store.get("activity", { type: "json" })) || [];
  await store.setJSON("activity", [...entries.reverse(), ...log].slice(0, 400));
}

async function allUsers(store) {
  const { blobs } = await store.list({ prefix: "users/" });
  const users = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return users.filter(Boolean);
}

export default async (req) => {
  if (!authConfigured()) return json({ error: "Set ADMIN_PASSWORD in Netlify environment variables" }, 500);

  const path = new URL(req.url).pathname.replace(/^\/api/, "");
  const method = req.method;
  const store = getStore({ name: "dates", consistency: "strong" });
  const body = method === "POST" || method === "PUT" ? await req.json().catch(() => ({})) : {};
  const session = verify((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));

  // ---------- accounts ----------
  if (path === "/signup" && method === "POST") {
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    if (!validName(name)) return json({ error: "Use 2–32 letters, numbers or spaces for your name" }, 400);
    if (String(body.password || "").length < 6) return json({ error: "Password needs at least 6 characters" }, 400);
    const k = nameKey(name);
    if (await store.get(userKey(k))) return json({ error: "That name is taken — sign in instead, or add a surname" }, 409);
    const now = Date.now();
    const user = {
      name, key: k, ...hashPassword(String(body.password)), email: "", push: [],
      tz: validTz(body.tz) ? body.tz : tzName(), created: now, lastSeen: now,
    };
    await store.setJSON(userKey(k), user);
    await store.setJSON(eventsKey(k), []);
    await logActivity(store, [{ user: name, action: "joined", at: now }]);
    return json({ token: sign({ u: k }), user: publicUser(user) });
  }

  if (path === "/login" && method === "POST") {
    const k = nameKey(body.name);
    const user = k && (await store.get(userKey(k), { type: "json" }));
    if (!user || !checkPassword(String(body.password || ""), user)) {
      await sleep(600);
      return json({ error: "Name or password is incorrect" }, 401);
    }
    if (!user.tz && validTz(body.tz)) { user.tz = body.tz; await store.setJSON(userKey(k), user); }
    return json({ token: sign({ u: k }), user: publicUser(user) });
  }

  // ---------- admin ----------
  if (path === "/admin/login" && method === "POST") {
    if (!checkAdmin(body.password)) { await sleep(600); return json({ error: "Wrong admin password" }, 401); }
    return json({ token: sign({ admin: true }, 7) });
  }

  if (path.startsWith("/admin/")) {
    if (!session?.admin) return json({ error: "Admin sign-in required" }, 401);

    if (path === "/admin/overview" && method === "GET") {
      const users = await allUsers(store);
      const rows = await Promise.all(users.map(async (u) => ({
        name: u.name, key: u.key, email: u.email || "", tz: u.tz || tzName(), devices: (u.push || []).length,
        created: u.created, lastSeen: u.lastSeen, lastDelivery: u.lastDelivery || null,
        events: (await store.get(eventsKey(u.key), { type: "json" })) || [],
      })));
      const [activity, deliveries] = await Promise.all([
        store.get("activity", { type: "json" }), store.get("deliveries", { type: "json" }),
      ]);
      return json({
        users: rows.sort((a, b) => b.lastSeen - a.lastSeen), activity: activity || [], deliveries: deliveries || [],
        mail: mailConfigured(), push: pushConfigured(), tz: tzName(),
      });
    }

    const pw = path.match(/^\/admin\/users\/(.+)\/password$/);
    if (pw && method === "PUT") {
      const k = decodeURIComponent(pw[1]);
      const user = await store.get(userKey(k), { type: "json" });
      if (!user) return json({ error: "No such user" }, 404);
      if (String(body.password || "").length < 6) return json({ error: "Password needs at least 6 characters" }, 400);
      Object.assign(user, hashPassword(String(body.password)));
      await store.setJSON(userKey(k), user);
      await logActivity(store, [{ user: user.name, action: "password reset by admin", at: Date.now() }]);
      return json({ ok: true });
    }

    const m = path.match(/^\/admin\/users\/(.+)$/);
    if (m && method === "DELETE") {
      const k = decodeURIComponent(m[1]);
      const user = await store.get(userKey(k), { type: "json" });
      if (!user) return json({ error: "No such user" }, 404);
      await store.delete(userKey(k));
      await store.delete(eventsKey(k));
      await logActivity(store, [{ user: user.name, action: "removed by admin", at: Date.now() }]);
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  }

  // ---------- signed-in user ----------
  const user = session?.u && (await store.get(userKey(session.u), { type: "json" }));
  if (!user) return json({ error: "Please sign in" }, 401);

  if (path === "/me" && method === "GET") {
    if (Date.now() - (user.lastSeen || 0) > 10 * 60e3) {
      user.lastSeen = Date.now();
      await store.setJSON(userKey(user.key), user);
    }
    const events = (await store.get(eventsKey(user.key), { type: "json" })) || [];
    return json({
      user: publicUser(user), events, tz: user.tz || tzName(),
      mail: mailConfigured(), push: pushConfigured(), vapidKey: vapidPublicKey(),
    });
  }

  if (path === "/events" && method === "PUT") {
    if (!Array.isArray(body.events)) return json({ error: "Expected { events: [...] }" }, 400);
    const events = body.events.slice(0, 5000).map(clean).filter(Boolean);
    const before = new Map(((await store.get(eventsKey(user.key), { type: "json" })) || []).map((e) => [e.id, e]));
    const now = Date.now();
    const log = [];
    for (const ev of events) {
      const old = before.get(ev.id);
      if (!old) log.push({ user: user.name, action: "added", type: ev.type, title: ev.title, at: now });
      else if (!sameEvent(old, ev)) log.push({ user: user.name, action: "edited", type: ev.type, title: ev.title, at: now });
      before.delete(ev.id);
    }
    for (const ev of before.values()) log.push({ user: user.name, action: "deleted", type: ev.type, title: ev.title, at: now });
    await store.setJSON(eventsKey(user.key), events);
    user.lastSeen = now;
    await store.setJSON(userKey(user.key), user);
    await logActivity(store, log);
    return json({ ok: true, count: events.length });
  }

  if (path === "/profile" && method === "PUT") {
    if ("email" in body) {
      const email = String(body.email || "").trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That email doesn't look right" }, 400);
      user.email = email;
    }
    if ("tz" in body) {
      if (!validTz(body.tz)) return json({ error: "Unknown time zone" }, 400);
      user.tz = body.tz;
    }
    await store.setJSON(userKey(user.key), user);
    return json({ user: publicUser(user) });
  }

  if (path === "/push/subscribe" && method === "POST") {
    if (!pushConfigured()) return json({ error: "Notifications aren't switched on for this site yet" }, 400);
    if (!validSubscription(body.subscription)) return json({ error: "Invalid subscription" }, 400);
    const { endpoint, keys } = body.subscription;
    user.push = [...(user.push || []).filter((s) => s.endpoint !== endpoint), { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, added: Date.now() }].slice(-10);
    await store.setJSON(userKey(user.key), user);
    return json({ user: publicUser(user) });
  }

  if (path === "/push/unsubscribe" && method === "POST") {
    user.push = (user.push || []).filter((s) => s.endpoint !== body.endpoint);
    await store.setJSON(userKey(user.key), user);
    return json({ user: publicUser(user) });
  }

  return json({ error: "Not found" }, 404);
};

export const config = { path: "/api/*" };
