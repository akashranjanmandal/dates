// Delivering one reminder to one person over every channel they've turned on,
// plus small storage helpers shared by the API and the scheduled job.
import { eventsKey, userKey } from "./auth.mjs";
import { mailConfigured, sendMail } from "./mail.mjs";
import { pushConfigured, pushToAll } from "./push.mjs";
import { appendLog, updateJSON } from "./store.mjs";

export { appendLog, updateJSON };

export const circleKey = (id) => `circles/${id}`;
export const circleEventsKey = (id) => `cevents/${id}`;
export const inviteKey = (code) => `invites/${code}`;
export const messagePrefix = (id) => `msgs/${id}/`;

export const getJSON = (store, key) => store.get(key, { type: "json" });

// Change a user record atomically (safe against the reminder job, phones subscribing, joins, etc.).
// `fn` mutates the user in place and may run more than once.
export async function patchUser(store, key, fn) {
  const { data } = await updateJSON(store, userKey(key), async (user) => {
    if (!user) return undefined;
    return (await fn(user)) || user;
  });
  return data;
}

export const userEvents = async (store, key) => (await getJSON(store, eventsKey(key))) || [];

/**
 * Sends `params` (EmailJS template variables) by email and `push` by Web Push.
 * `skip` lets the caller suppress a channel that already succeeded earlier.
 * Returns per-channel results plus log entries for the delivery history.
 */
export async function deliver(user, params, push, { skip = {}, label } = {}) {
  const res = { email: null, push: null, log: [], goneEndpoints: [] };
  const at = Date.now(), title = label || params.title;

  if (!skip.email && mailConfigured() && user.email) {
    try {
      await sendMail(params, user.email);
      res.email = { ok: true };
      res.log.push({ at, user: user.name, title, channel: "email", ok: true, to: user.email });
    } catch (e) {
      res.email = { ok: false, error: e.message.slice(0, 240) };
      res.log.push({ at, user: user.name, title, channel: "email", ok: false, error: res.email.error });
    }
  }

  if (!skip.push && pushConfigured() && user.push?.length) {
    const r = await pushToAll(user.push, push);
    res.goneEndpoints = r.gone;
    const ok = r.sent > 0;
    const error = ok ? "" : r.error || (r.gone.length ? "This phone's notification permission expired — turn notifications on again" : "No active devices");
    res.push = { ok, sent: r.sent, failed: r.failed + r.gone.length, error };
    res.log.push({ at, user: user.name, title, channel: "push", ok, ...(ok ? { to: `${r.sent} device${r.sent > 1 ? "s" : ""}` } : { error }) });
  }
  return res;
}
