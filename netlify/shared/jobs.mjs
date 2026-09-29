// The reminder job: finds every reminder that just came due — for each person's own dates
// and for the circles they belong to — and delivers it by email and phone notification.
import { getStore } from "@netlify/blobs";
import { mailConfigured, reminderParams } from "./mail.mjs";
import { pushConfigured } from "./push.mjs";
import { computeDue, tzName, validTz } from "./schedule.mjs";
import { appendLog, circleEventsKey, circleKey, deliver, getJSON, patchUser, userEvents } from "./deliver.mjs";

// Failed sends back off (5 → 15 → 30 → 60 → 120 min) and stop after 6 tries per channel,
// so a broken email setup can't burn through the EmailJS quota.
const BACKOFF_MIN = [5, 15, 30, 60, 120];
const MAX_TRIES = 6;

export async function runReminders(now = Date.now()) {
  const store = getStore({ name: "dates", consistency: "strong" });
  const beat = { at: now, users: 0, due: 0, delivered: 0, failed: 0, error: "" };

  try {
    if (!mailConfigured() && !pushConfigured()) {
      beat.error = "No email (EMAILJS_PUBLIC_KEY) or notifications (VAPID_*) configured";
      return;
    }
    const sent = (await getJSON(store, "sent")) || {};
    const retries = (await getJSON(store, "retries")) || {};
    const waiting = (k) => {
      const r = retries[k];
      return r && (r.n >= MAX_TRIES || now - r.last < BACKOFF_MIN[Math.min(r.n - 1, BACKOFF_MIN.length - 1)] * 60e3);
    };
    const circleCache = new Map();
    const loadCircle = async (id) => {
      if (!circleCache.has(id)) {
        const [c, evs] = await Promise.all([getJSON(store, circleKey(id)), getJSON(store, circleEventsKey(id))]);
        circleCache.set(id, c ? { circle: c, events: evs || [] } : null);
      }
      return circleCache.get(id);
    };

    const { blobs } = await store.list({ prefix: "users/" });
    const log = [];

    for (const { key } of blobs) {
      const user = await getJSON(store, key);
      if (!user) continue;
      const hasEmail = mailConfigured() && user.email, hasPush = pushConfigured() && user.push?.length;
      if (!hasEmail && !hasPush) continue;
      beat.users++;
      const tz = validTz(user.tz) ? user.tz : tzName();

      // Own dates + dates of every circle they haven't muted.
      const sources = [{ events: await userEvents(store, user.key), circle: null }];
      for (const id of user.circles || []) {
        if (user.circlePrefs?.[id]?.mute) continue;
        const c = await loadCircle(id);
        if (c && c.circle.members.includes(user.key)) sources.push({ events: c.events, circle: c.circle });
      }

      const results = [];
      for (const src of sources) {
        for (const d of computeDue(src.events, {}, now, tz)) {
          const base = `${user.key}|${d.k}`;
          // Older runs stored a single key per reminder; honour it so nothing is sent twice.
          const done = (ch) => sent[`${base}|${ch}`] || sent[d.k] || sent[base];
          const skip = {
            email: !hasEmail || done("email") || waiting(`${base}|email`),
            push: !hasPush || done("push") || waiting(`${base}|push`),
          };
          if (skip.email && skip.push) continue;
          beat.due++;

          const params = reminderParams(d.ev, d.occ, now, tz);
          if (src.circle) params.tagline_html += ` <span style="color:#a39a91">· shared in ${escapeHtml(src.circle.name)}</span>`;
          const r = await deliver(user, params, {
            title: params.title,
            body: `${params.when} · ${params.weekday}, ${params.day} ${cap(params.month)}${src.circle ? ` · ${src.circle.name}` : ""}`,
            tag: base, url: src.circle ? `/?circle=${src.circle.id}` : "/",
          }, { skip });
          log.push(...r.log);
          results.push({ r, title: params.title });

          for (const ch of ["email", "push"]) {
            const out = r[ch];
            if (!out) continue;
            const k = `${base}|${ch}`;
            if (out.ok) { sent[k] = now; delete retries[k]; beat.delivered++; }
            else { retries[k] = { n: (retries[k]?.n || 0) + 1, last: now }; beat.failed++; }
          }
        }
      }

      if (results.length) {
        const last = results.at(-1);
        const ok = Boolean(last.r.email?.ok || last.r.push?.ok);
        const errors = [last.r.email, last.r.push].filter((x) => x && !x.ok).map((x) => x.error);
        const gone = results.flatMap((x) => x.r.goneEndpoints);
        await patchUser(store, user.key, (u) => {
          u.lastDelivery = { at: now, ok, title: last.title, error: errors.join(" · ") };
          if (gone.length) u.push = (u.push || []).filter((s) => !gone.includes(s.endpoint));
        });
      }
    }

    if (log.length) {
      for (const [k, t] of Object.entries(sent)) if (now - t > 400 * 864e5) delete sent[k];
      for (const [k, r] of Object.entries(retries)) if (now - r.last > 2 * 864e5) delete retries[k];
      await store.setJSON("sent", sent);
      await store.setJSON("retries", retries);
      await appendLog(store, "deliveries", log, 600);
    }
  } catch (e) {
    beat.error = String(e?.stack || e).slice(0, 400);
    throw e;
  } finally {
    beat.ms = Date.now() - now;
    await store.setJSON("heartbeat", beat).catch(() => {});
    console.log(`Reminders: ${beat.delivered} delivered, ${beat.failed} failed, ${beat.users} users checked${beat.error ? ` — ${beat.error}` : ""}`);
  }
}

const cap = (s) => s.charAt(0) + s.slice(1).toLowerCase();
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
