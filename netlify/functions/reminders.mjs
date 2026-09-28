// Scheduled job: runs every 30 minutes and emails each user the reminders that just came due.
import { getStore } from "@netlify/blobs";
import { eventsKey } from "../shared/auth.mjs";
import { computeDue, tzName } from "../shared/schedule.mjs";
import { mailConfigured, reminderParams, sendMail } from "../shared/mail.mjs";

export default async () => {
  if (!mailConfigured()) {
    console.log("Skipping: EMAILJS_PUBLIC_KEY not set");
    return;
  }
  const tz = tzName();
  const now = Date.now();
  const store = getStore({ name: "dates", consistency: "strong" });
  const sent = (await store.get("sent", { type: "json" })) || {};
  const { blobs } = await store.list({ prefix: "users/" });

  let ok = 0, total = 0;
  for (const { key } of blobs) {
    const user = await store.get(key, { type: "json" });
    if (!user?.email) continue;
    const events = (await store.get(eventsKey(user.key), { type: "json" })) || [];
    for (const d of computeDue(events, sent, now, tz)) {
      total++;
      try {
        await sendMail(reminderParams(d.ev, d.occ, now, tz), user.email);
        sent[d.k] = now;
        ok++;
      } catch (e) {
        console.error(`Failed ${user.key} ${d.k}: ${e.message}`); // retried on the next run
      }
    }
  }
  if (!total) return;
  for (const [k, t] of Object.entries(sent)) if (now - t > 400 * 864e5) delete sent[k];
  await store.setJSON("sent", sent);
  console.log(`Sent ${ok}/${total} reminder(s)`);
};

// :00 and :30 of every hour (UTC) — lands exactly on 9:00 PM in whole- and half-hour timezones like IST.
export const config = { schedule: "0,30 * * * *" };
