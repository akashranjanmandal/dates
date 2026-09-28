// Scheduled job: runs every 5 minutes and delivers each user's due reminders
// by email (EmailJS) and phone notification (Web Push).
import { getStore } from "@netlify/blobs";
import { eventsKey, userKey } from "../shared/auth.mjs";
import { mailConfigured, reminderParams, sendMail } from "../shared/mail.mjs";
import { pushConfigured, pushToAll } from "../shared/push.mjs";
import { computeDue, tzName, validTz } from "../shared/schedule.mjs";

export async function runReminders(now = Date.now()) {
  const mail = mailConfigured(), push = pushConfigured();
  if (!mail && !push) return console.log("Skipping: no email (EMAILJS_PUBLIC_KEY) or push (VAPID_*) configured");

  const store = getStore({ name: "dates", consistency: "strong" });
  const sent = (await store.get("sent", { type: "json" })) || {};
  // Failed reminders back off (5 min → 30 min → 2 h) and give up after 4 tries, so a broken
  // email setup can't burn through the EmailJS quota.
  const retries = (await store.get("retries", { type: "json" })) || {};
  const BACKOFF = [5, 30, 120].map((m) => m * 60e3);
  const waiting = (k) => {
    const r = retries[k];
    return r && (r.n >= 4 || now - r.last < BACKOFF[Math.min(r.n - 1, BACKOFF.length - 1)]);
  };
  const { blobs } = await store.list({ prefix: "users/" });
  const log = [];

  for (const { key } of blobs) {
    const user = await store.get(key, { type: "json" });
    if (!user) continue;
    const wantsEmail = mail && user.email;
    const wantsPush = push && user.push?.length;
    if (!wantsEmail && !wantsPush) continue;

    const tz = validTz(user.tz) ? user.tz : tzName();
    const events = (await store.get(eventsKey(user.key), { type: "json" })) || [];
    const due = computeDue(events, sent, now, tz).filter((d) => !waiting(d.k));
    if (!due.length) continue;

    let userChanged = false;
    for (const d of due) {
      const params = reminderParams(d.ev, d.occ, now, tz);
      let delivered = false;

      if (wantsEmail) {
        try {
          await sendMail(params, user.email);
          delivered = true;
          log.push({ at: now, user: user.name, title: params.title, channel: "email", ok: true, to: user.email });
        } catch (e) {
          log.push({ at: now, user: user.name, title: params.title, channel: "email", ok: false, error: e.message.slice(0, 240) });
        }
      }

      if (user.push?.length && push) {
        const r = await pushToAll(user.push, {
          title: params.title,
          body: `${params.when} · ${params.weekday}, ${params.day} ${params.month.charAt(0)}${params.month.slice(1).toLowerCase()}`,
          tag: d.k,
          url: "/",
        });
        if (r.gone.length) { user.push = user.push.filter((s) => !r.gone.includes(s.endpoint)); userChanged = true; }
        if (r.sent) delivered = true;
        log.push({
          at: now, user: user.name, title: params.title, channel: "push", ok: r.sent > 0,
          ...(r.sent ? { to: `${r.sent} device${r.sent > 1 ? "s" : ""}` } : { error: r.error || "No active devices" }),
        });
      }

      // Only mark as sent once something got through; failures retry on the next run (within 12h).
      if (delivered) { sent[d.k] = now; delete retries[d.k]; }
      else retries[d.k] = { n: (retries[d.k]?.n || 0) + 1, last: now };
      const errors = log.filter((l) => l.at === now && l.user === user.name && l.title === params.title && !l.ok).map((l) => l.error);
      user.lastDelivery = { at: now, ok: delivered, title: params.title, error: delivered ? "" : errors.join(" · ") };
      userChanged = true;
    }
    if (userChanged) await store.setJSON(userKey(user.key), user);
  }

  if (!log.length) return;
  for (const [k, t] of Object.entries(sent)) if (now - t > 400 * 864e5) delete sent[k];
  await store.setJSON("sent", sent);
  for (const [k, r] of Object.entries(retries)) if (now - r.last > 2 * 864e5) delete retries[k];
  await store.setJSON("retries", retries);
  const history = (await store.get("deliveries", { type: "json" })) || [];
  await store.setJSON("deliveries", [...log.reverse(), ...history].slice(0, 600));
  console.log(`Reminders: ${log.filter((l) => l.ok).length} delivered, ${log.filter((l) => !l.ok).length} failed`);
}

export default async () => { await runReminders(); };

// Every 5 minutes, so any reminder time a person picks lands within 5 minutes.
export const config = { schedule: "*/5 * * * *" };
