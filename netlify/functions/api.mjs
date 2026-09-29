import { getStore } from "@netlify/blobs";
import {
  authConfigured, checkAdmin, checkPassword, eventsKey, hashPassword, nameKey, sign, userKey, validName, verify,
} from "../shared/auth.mjs";
import {
  appendLog, circleEventsKey, circleKey, deliver, getJSON, inviteKey, messagePrefix, patchUser, updateJSON, userEvents,
} from "../shared/deliver.mjs";
import { mailConfigured } from "../shared/mail.mjs";
import { googleConfig, verifyGoogleToken } from "../shared/google.mjs";
import { pushConfigured, pushToAll, validSubscription, vapidPublicKey } from "../shared/push.mjs";
import { normRemind, remindKey, tzName, validTz } from "../shared/schedule.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => abc[b % abc.length]).join("");
};

const TYPES = new Set(["birthday", "anniversary", "event", "other"]);
const MAX_CIRCLE_MEMBERS = 50, MAX_CIRCLES = 20, MAX_MESSAGES = 1000;
const B64URL = /^[A-Za-z0-9_-]+$/;

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
  name: u.name, key: u.key, email: u.email || "", tz: u.tz || tzName(),
  devices: (u.push || []).length, lastDelivery: u.lastDelivery || null,
});
const CORE = ["type", "title", "date", "yearUnknown", "time", "repeat", "remind", "notes"];
const sameEvent = (a, b) => CORE.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));

// What a member sees about a circle. The chat key itself never reaches the server.
const circleView = (c, u) => ({
  id: c.id, name: c.name, created: c.created, isOwner: c.owner === u.key,
  owner: c.names[c.owner] || "", invite: c.code, keyCheck: c.keyCheck || null,
  members: c.members.map((k) => ({ key: k, name: c.names[k] || k })),
  muted: Boolean(u.circlePrefs?.[c.id]?.mute), lastMsgAt: c.lastMsgAt || 0,
});

const logActivity = (store, entries) => appendLog(store, "activity", entries, 400).catch(() => {});

async function allUsers(store) {
  const { blobs } = await store.list({ prefix: "users/" });
  return (await Promise.all(blobs.map((b) => getJSON(store, b.key)))).filter(Boolean);
}

async function deleteCircle(store, c) {
  const { blobs } = await store.list({ prefix: messagePrefix(c.id) });
  await Promise.all(blobs.map((b) => store.delete(b.key)));
  await Promise.all([store.delete(circleKey(c.id)), store.delete(circleEventsKey(c.id)), store.delete(inviteKey(c.code))]);
  await Promise.all(c.members.map((k) => patchUser(store, k, (u) => { u.circles = (u.circles || []).filter((x) => x !== c.id); }).catch(() => {})));
}

// Takes someone out of a circle (leaving, being removed, or their account being deleted).
async function removeMember(store, id, key) {
  const { data: c } = await updateJSON(store, circleKey(id), (cur) => {
    if (!cur || !cur.members.includes(key)) return undefined;
    cur.members = cur.members.filter((k) => k !== key);
    if (cur.owner === key && cur.members.length) cur.owner = cur.members[0];
    return cur;
  });
  await patchUser(store, key, (u) => { u.circles = (u.circles || []).filter((x) => x !== id); }).catch(() => {});
  if (c && !c.members.length) await deleteCircle(store, c);
}

export default async (req) => {
  if (!authConfigured()) return json({ error: "Set ADMIN_PASSWORD in Netlify environment variables" }, 500);

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "");
  const method = req.method;
  const store = getStore({ name: "dates", consistency: "strong" });
  const body = ["POST", "PUT", "PATCH"].includes(method) ? await req.json().catch(() => ({})) : {};
  const session = verify((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  try {
    return await handle(req, { url, path, method, store, body, session });
  } catch (e) {
    console.error(e);
    return json({ error: e.status === 409 ? e.message : "Something went wrong on our side — please try again" }, e.status || 500);
  }
};

async function handle(req, { url, path, method, store, body, session }) {

  // A single event as a calendar file — opens straight in Apple Calendar on iPhone.
  if (path === "/ics" && method === "GET") {
    const q = url.searchParams, esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
    const s = (q.get("s") || "").replace(/\D/g, "").slice(0, 8), h = (q.get("h") || "").replace(/\D/g, "").slice(0, 4);
    if (s.length !== 8) return json({ error: "Bad date" }, 400);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const y = +s.slice(0, 4), m = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
    const nextDay = new Date(Date.UTC(y, m, d + 1)).toISOString().slice(0, 10).replace(/-/g, "");
    const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Wishly//EN", "BEGIN:VEVENT", `UID:${s}${h}-${Math.abs([...(q.get("t") || "")].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))}@wishly`, `DTSTAMP:${stamp}`, `SUMMARY:${esc((q.get("t") || "Wishly").slice(0, 200))}`];
    if (h.length === 4) { const eh = String((+h.slice(0, 2) + 1) % 24).padStart(2, "0"); L.push(`DTSTART:${s}T${h}00`, `DTEND:${s}T${eh}${h.slice(2)}00`); }
    else L.push(`DTSTART;VALUE=DATE:${s}`, `DTEND;VALUE=DATE:${nextDay}`);
    if (q.get("y")) L.push("RRULE:FREQ=YEARLY");
    if (q.get("n")) L.push(`DESCRIPTION:${esc(q.get("n").slice(0, 500))}`);
    L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT15H", "END:VALARM", "END:VEVENT", "END:VCALENDAR");
    return new Response(L.join("\r\n") + "\r\n", { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="wishly.ics"', "cache-control": "no-store" } });
  }

  // What the sign-in screen needs before anyone is signed in.
  if (path === "/public" && method === "GET") return json({ google: googleConfig() });

  // Google sign-in: the browser sends a Firebase ID token; we verify it and open (or create) that person's space.
  if (path === "/google" && method === "POST") {
    let g;
    try { g = await verifyGoogleToken(body.idToken); } catch { await sleep(400); return json({ error: "Google sign-in couldn't be verified. Please try again." }, 401); }
    const k = `g:${g.sub}`, now = Date.now();
    let user = await getJSON(store, userKey(k)), isNew = false;
    if (!user) {
      const name = (g.name || g.email.split("@")[0] || "Friend").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, 32) || "Friend";
      user = { name, key: k, google: true, email: g.verified ? g.email : "", push: [], circles: [], tz: validTz(body.tz) ? body.tz : tzName(), created: now, lastSeen: now };
      const made = await store.setJSON(userKey(k), user, { onlyIfNew: true });
      if (made.modified) { isNew = true; await store.setJSON(eventsKey(k), []); await logActivity(store, [{ user: name, action: "joined", at: now }]); }
      else user = await getJSON(store, userKey(k));
    }
    return json({ token: sign({ u: k }), user: publicUser(user), isNew });
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
        circles: (u.circles || []).length, events: await userEvents(store, u.key),
      })));
      const { blobs: cblobs } = await store.list({ prefix: "circles/" });
      const circles = await Promise.all(cblobs.map(async (b) => {
        const c = await getJSON(store, b.key);
        if (!c) return null;
        const [evs, msgs] = await Promise.all([getJSON(store, circleEventsKey(c.id)), store.list({ prefix: messagePrefix(c.id) })]);
        return {
          id: c.id, name: c.name, owner: c.names[c.owner] || "", created: c.created, lastMsgAt: c.lastMsgAt || 0,
          members: c.members.map((k) => c.names[k] || k), events: (evs || []).length, messages: msgs.blobs.length,
        };
      }));
      const [activity, deliveries, heartbeat] = await Promise.all([
        getJSON(store, "activity"), getJSON(store, "deliveries"), getJSON(store, "heartbeat"),
      ]);
      return json({
        users: rows.sort((a, b) => b.lastSeen - a.lastSeen), circles: circles.filter(Boolean),
        activity: activity || [], deliveries: deliveries || [], heartbeat: heartbeat || null,
        mail: mailConfigured(), push: pushConfigured(), tz: tzName(),
      });
    }

    const pw = path.match(/^\/admin\/users\/(.+)\/password$/);
    if (pw && method === "PUT") {
      const k = decodeURIComponent(pw[1]);
      if (String(body.password || "").length < 6) return json({ error: "Password needs at least 6 characters" }, 400);
      const user = await patchUser(store, k, (u) => { Object.assign(u, hashPassword(String(body.password))); });
      if (!user) return json({ error: "No such user" }, 404);
      await logActivity(store, [{ user: user.name, action: "password reset by admin", at: Date.now() }]);
      return json({ ok: true });
    }

    const du = path.match(/^\/admin\/users\/(.+)$/);
    if (du && method === "DELETE") {
      const k = decodeURIComponent(du[1]);
      const user = await getJSON(store, userKey(k));
      if (!user) return json({ error: "No such user" }, 404);
      for (const id of user.circles || []) await removeMember(store, id, k).catch(() => {});
      await store.delete(userKey(k));
      await store.delete(eventsKey(k));
      await logActivity(store, [{ user: user.name, action: "removed by admin", at: Date.now() }]);
      return json({ ok: true });
    }

    const dc = path.match(/^\/admin\/circles\/([\w-]+)$/);
    if (dc && method === "DELETE") {
      const c = await getJSON(store, circleKey(dc[1]));
      if (!c) return json({ error: "No such circle" }, 404);
      await deleteCircle(store, c);
      await logActivity(store, [{ user: "Admin", action: "deleted circle", title: c.name, at: Date.now() }]);
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  }

  // ---------- signed-in user ----------
  let user = session?.u && (await getJSON(store, userKey(session.u)));
  if (!user) return json({ error: "Please sign in" }, 401);

  if (path === "/me" && method === "GET") {
    if (Date.now() - (user.lastSeen || 0) > 10 * 60e3) user = await patchUser(store, user.key, (u) => { u.lastSeen = Date.now(); });
    const circles = (await Promise.all((user.circles || []).map((id) => getJSON(store, circleKey(id)))))
      .filter((c) => c && c.members.includes(user.key)).map((c) => circleView(c, user));
    return json({
      user: publicUser(user), events: await userEvents(store, user.key), circles, tz: user.tz || tzName(),
      mail: mailConfigured(), push: pushConfigured(), vapidKey: vapidPublicKey(),
    });
  }

  // Light refresh of the circles I'm in (member changes, unread chat badges) without the dates.
  if (path === "/circles" && method === "GET") {
    const circles = (await Promise.all((user.circles || []).map((id) => getJSON(store, circleKey(id)))))
      .filter((c) => c && c.members.includes(user.key)).map((c) => circleView(c, user));
    return json({ circles });
  }

  if (path === "/events" && method === "PUT") {
    if (!Array.isArray(body.events)) return json({ error: "Expected { events: [...] }" }, 400);
    const events = body.events.slice(0, 5000).map(clean).filter(Boolean);
    const before = new Map((await userEvents(store, user.key)).map((e) => [e.id, e]));
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
    await patchUser(store, user.key, (u) => { u.lastSeen = now; });
    await logActivity(store, log);
    return json({ ok: true, count: events.length });
  }

  if (path === "/profile" && method === "PUT") {
    if ("email" in body) {
      const email = String(body.email || "").trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That email doesn't look right" }, 400);
    }
    if ("tz" in body && !validTz(body.tz)) return json({ error: "Unknown time zone" }, 400);
    user = await patchUser(store, user.key, (u) => {
      if ("email" in body) u.email = String(body.email || "").trim();
      if ("tz" in body) u.tz = body.tz;
    });
    return json({ user: publicUser(user) });
  }

  if (path === "/push/subscribe" && method === "POST") {
    if (!pushConfigured()) return json({ error: "Notifications aren't switched on for this site yet" }, 400);
    if (!validSubscription(body.subscription)) return json({ error: "Invalid subscription" }, 400);
    const { endpoint, keys } = body.subscription;
    user = await patchUser(store, user.key, (u) => {
      u.push = [...(u.push || []).filter((s) => s.endpoint !== endpoint), { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, added: Date.now() }].slice(-10);
    });
    return json({ user: publicUser(user) });
  }

  if (path === "/push/unsubscribe" && method === "POST") {
    user = await patchUser(store, user.key, (u) => { u.push = (u.push || []).filter((s) => s.endpoint !== body.endpoint); });
    return json({ user: publicUser(user) });
  }

  // Sends a sample reminder right now over every channel and reports exactly what happened.
  if (path === "/test-reminder" && method === "POST") {
    if (Date.now() - (user.lastTest || 0) < 30e3) return json({ error: "Please wait 30 seconds between tests" }, 429);
    if (!(mailConfigured() && user.email) && !(pushConfigured() && user.push?.length)) {
      return json({ error: "Add your email or turn on phone notifications first" }, 400);
    }
    const now = new Date();
    const day = now.toLocaleDateString("en-GB", { timeZone: user.tz || tzName(), day: "numeric" });
    const params = {
      subject: "Test reminder from Wishly — it works!",
      title: "This is a test reminder",
      when: "Right now",
      day, month: now.toLocaleDateString("en-GB", { timeZone: user.tz || tzName(), month: "short" }).toUpperCase(),
      weekday: now.toLocaleDateString("en-GB", { timeZone: user.tz || tzName(), weekday: "long" }),
      tagline_html: "If you can read this, your reminders will reach you here.",
      notes_html: "", gcal_url: "https://calendar.google.com/",
    };
    const r = await deliver(user, params, { title: "Wishly test", body: "Notifications are working on this device.", tag: "wishly-test", url: "/" }, { label: "Test reminder" });
    await appendLog(store, "deliveries", r.log, 600);
    user = await patchUser(store, user.key, (u) => {
      u.lastTest = Date.now();
      if (r.goneEndpoints.length) u.push = (u.push || []).filter((s) => !r.goneEndpoints.includes(s.endpoint));
    });
    return json({ email: r.email, push: r.push, user: publicUser(user) });
  }

  // ---------- circles (shared spaces) ----------
  if (path === "/circles" && method === "POST") {
    const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (name.length < 2) return json({ error: "Give your circle a name" }, 400);
    if ((user.circles || []).length >= MAX_CIRCLES) return json({ error: `You can be in up to ${MAX_CIRCLES} circles` }, 400);
    const kc = body.keyCheck;
    if (kc && !(B64URL.test(kc.iv || "") && B64URL.test(kc.ct || "") && kc.ct.length < 200)) return json({ error: "Bad key check" }, 400);
    const id = rand(12), code = rand(10), now = Date.now();
    const c = { id, name, owner: user.key, members: [user.key], names: { [user.key]: user.name }, code, keyCheck: kc || null, created: now };
    await store.setJSON(circleKey(id), c);
    await store.setJSON(circleEventsKey(id), []);
    await store.setJSON(inviteKey(code), { id });
    user = await patchUser(store, user.key, (u) => { u.circles = [...new Set([...(u.circles || []), id])]; });
    await logActivity(store, [{ user: user.name, action: "created circle", title: name, at: now }]);
    return json({ circle: circleView(c, user) });
  }

  if (path === "/circles/join" && method === "POST") {
    const inv = /^[A-Za-z0-9]{6,20}$/.test(body.code || "") && (await getJSON(store, inviteKey(body.code)));
    const c = inv && (await getJSON(store, circleKey(inv.id)));
    if (!c) return json({ error: "This invite link is no longer valid — ask for a new one" }, 404);
    let joined = false, full = false;
    const { data: latest } = await updateJSON(store, circleKey(c.id), (cur) => {
      joined = false; full = false;
      if (!cur) return undefined;
      if (cur.members.includes(user.key)) return undefined;
      if (cur.members.length >= MAX_CIRCLE_MEMBERS) { full = true; return undefined; }
      cur.members.push(user.key);
      cur.names[user.key] = user.name;
      joined = true;
      return cur;
    });
    if (full) return json({ error: "This circle is full" }, 400);
    if (!user.circles?.includes(c.id) && (user.circles || []).length >= MAX_CIRCLES) return json({ error: `You can be in up to ${MAX_CIRCLES} circles` }, 400);
    user = await patchUser(store, user.key, (u) => { u.circles = [...new Set([...(u.circles || []), c.id])]; });
    if (joined) await logActivity(store, [{ user: user.name, action: "joined circle", title: c.name, at: Date.now() }]);
    return json({ circle: circleView(latest || c, user) });
  }

  const cm = path.match(/^\/circles\/([\w-]+)(\/.*)?$/);
  if (cm) {
    const c = await getJSON(store, circleKey(cm[1]));
    if (!c || !c.members.includes(user.key)) return json({ error: "You're not in this circle" }, 404);
    const sub = cm[2] || "";

    if (sub === "" && method === "GET") {
      return json({ circle: circleView(c, user), events: (await getJSON(store, circleEventsKey(c.id))) || [] });
    }

    if (sub === "" && method === "PUT") {
      if (c.owner !== user.key) return json({ error: "Only the circle's owner can rename it" }, 403);
      const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 40);
      if (name.length < 2) return json({ error: "Give your circle a name" }, 400);
      const { data } = await updateJSON(store, circleKey(c.id), (cur) => { if (!cur) return undefined; cur.name = name; return cur; });
      return json({ circle: circleView(data || c, user) });
    }

    // Members change dates one at a time; each change is merged into the latest list so that
    // several people adding dates at the same moment never overwrite each other.
    if (sub === "/events" && method === "PATCH") {
      const now = Date.now();
      let log = [], tooMany = false;
      const { data: events } = await updateJSON(store, circleEventsKey(c.id), (list) => {
        log = []; tooMany = false;
        const map = new Map((list || []).map((e) => [e.id, e]));
        let changed = false;
        for (const raw of (Array.isArray(body.upsert) ? body.upsert : []).slice(0, 500)) {
          const ev = clean(raw);
          if (!ev) continue;
          const old = map.get(ev.id);
          if (old && sameEvent(old, ev)) continue;
          map.set(ev.id, { ...ev, by: old?.by || user.name, ...(old ? { editedBy: user.name } : {}) });
          log.push({ user: user.name, action: old ? "edited" : "added", type: ev.type, title: `${ev.title} (in ${c.name})`, at: now });
          changed = true;
        }
        for (const id of Array.isArray(body.remove) ? body.remove : []) {
          const old = map.get(id);
          if (!old) continue;
          map.delete(id);
          log.push({ user: user.name, action: "deleted", type: old.type, title: `${old.title} (in ${c.name})`, at: now });
          changed = true;
        }
        if (map.size > 5000) { tooMany = true; return undefined; }
        return changed ? [...map.values()] : undefined;
      });
      if (tooMany) return json({ error: "This circle has too many dates" }, 400);
      await logActivity(store, log);
      return json({ events: events || ((await getJSON(store, circleEventsKey(c.id))) || []) });
    }

    if (sub === "/prefs" && method === "PUT") {
      user = await patchUser(store, user.key, (u) => { u.circlePrefs = { ...(u.circlePrefs || {}), [c.id]: { mute: Boolean(body.mute) } }; });
      return json({ circle: circleView(c, user) });
    }

    if (sub === "/leave" && method === "POST") {
      await removeMember(store, c.id, user.key);
      await logActivity(store, [{ user: user.name, action: "left circle", title: c.name, at: Date.now() }]);
      return json({ ok: true });
    }

    const rm = sub.match(/^\/members\/(.+)$/);
    if (rm && method === "DELETE") {
      if (c.owner !== user.key) return json({ error: "Only the circle's owner can remove people" }, 403);
      const k = decodeURIComponent(rm[1]);
      if (!c.members.includes(k) || k === user.key) return json({ error: "Not a member" }, 400);
      await removeMember(store, c.id, k);
      return json({ circle: circleView(await getJSON(store, circleKey(c.id)), user) });
    }

    if (sub === "/invite" && method === "POST") {
      if (c.owner !== user.key) return json({ error: "Only the circle's owner can reset the invite link" }, 403);
      const code = rand(10);
      await store.setJSON(inviteKey(code), { id: c.id });
      const { data } = await updateJSON(store, circleKey(c.id), (cur) => { if (!cur) return undefined; cur.code = code; return cur; });
      await store.delete(inviteKey(c.code));
      return json({ circle: circleView(data || c, user) });
    }

    // ----- end-to-end encrypted chat: the server only ever stores ciphertext -----
    if (sub === "/messages" && method === "GET") {
      const after = url.searchParams.get("after") || "";
      // Nothing new? Answer from the circle record alone — no listing, no message reads.
      if (after && (c.lastMsgId || "") <= after) return json({ messages: [], more: false });
      const prefix = messagePrefix(c.id);
      const { blobs } = await store.list({ prefix });
      const keys = blobs.map((b) => b.key).sort();
      const fresh = after ? keys.filter((k) => k.slice(prefix.length) > after) : keys;
      const pick = fresh.slice(-60);
      const messages = (await Promise.all(pick.map((k) => getJSON(store, k)))).filter(Boolean);
      return json({ messages, more: fresh.length > pick.length });
    }

    if (sub === "/messages" && method === "POST") {
      const { iv, ct } = body;
      if (!B64URL.test(iv || "") || iv.length > 24 || !B64URL.test(ct || "") || ct.length > 12000) return json({ error: "Message is not properly encrypted" }, 400);
      const now = Date.now();
      const id = `${String(now).padStart(14, "0")}-${rand(6)}`;
      const msg = { id, from: user.name, fromKey: user.key, at: now, iv, ct };
      await store.setJSON(messagePrefix(c.id) + id, msg);
      const { data: cur } = await updateJSON(store, circleKey(c.id), (x) => {
        if (!x) return undefined;
        if ((x.lastMsgId || "") >= id) return undefined;
        x.lastMsgAt = now; x.lastMsgId = id; x.msgCount = (x.msgCount || 0) + 1;
        return x;
      });

      // Let the others know — the notification can't include the text (the server can't read it).
      const others = await Promise.all(c.members.filter((k) => k !== user.key).map((k) => getJSON(store, userKey(k))));
      const notify = Promise.allSettled(others.filter((u) => u?.push?.length && !u.circlePrefs?.[c.id]?.mute).map((u) =>
        pushToAll(u.push, { title: c.name, body: `${user.name} sent a message`, tag: `chat-${c.id}`, url: `/?circle=${c.id}&tab=chat`, kind: "chat", circle: c.id })));
      await Promise.race([notify, sleep(2500)]);

      // Keep the newest 1000 messages (checked every so often, not on every send).
      if (((cur?.msgCount || 0) % 40) === 0) {
        const { blobs } = await store.list({ prefix: messagePrefix(c.id) });
        if (blobs.length > MAX_MESSAGES) {
          const old = blobs.map((b) => b.key).sort().slice(0, blobs.length - MAX_MESSAGES);
          await Promise.all(old.map((k) => store.delete(k)));
        }
      }
      return json({ message: msg });
    }

    return json({ error: "Not found" }, 404);
  }

  return json({ error: "Not found" }, 404);
}

export const config = { path: "/api/*" };
