// Sends email through EmailJS's REST API (https://www.emailjs.com/docs/rest-api/send/).
import { describe, relativeDay } from "./schedule.mjs";

const cfg = () => ({
  service: process.env.EMAILJS_SERVICE_ID || "service_ls3809j",
  template: process.env.EMAILJS_TEMPLATE_ID || "template_8o97oyb",
  publicKey: process.env.EMAILJS_PUBLIC_KEY,
  privateKey: process.env.EMAILJS_PRIVATE_KEY,
});

export const mailConfigured = () => Boolean(cfg().publicKey);

// EmailJS rejects bursts (HTTP 429), so sends are spaced out and a rate-limited one is retried.
let lastSend = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `to` is the person's own reminder address (set in their Settings).
export async function sendMail(params, to) {
  const c = cfg();
  const body = JSON.stringify({
    service_id: c.service,
    template_id: c.template,
    user_id: c.publicKey,
    ...(c.privateKey && { accessToken: c.privateKey }),
    template_params: { to_email: to, app_url: (process.env.URL || "").replace(/\/$/, ""), ...params },
  });
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastSend + 1200 - Date.now();
    if (wait > 0) await sleep(wait);
    lastSend = Date.now();
    let res;
    try {
      res = await fetch("https://api.emailjs.com/api/v1.0/email/send", { method: "POST", headers: { "content-type": "application/json" }, body });
    } catch (e) { lastErr = new Error(`Couldn't reach EmailJS: ${e.message}`); await sleep(1500); continue; }
    if (res.ok) return;
    const text = (await res.text()).slice(0, 300);
    lastErr = new Error(`EmailJS ${res.status}: ${text}`);
    if (res.status !== 429 && res.status < 500) break; // a real rejection — retrying won't help
    await sleep(1500 * (attempt + 1));
  }
  throw lastErr;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");

function fmtTime(t) {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

function gcalUrl(ev, occ, tz, heading) {
  const day = `${occ.y}${pad(occ.m)}${pad(occ.d)}`;
  const p = new URLSearchParams({ action: "TEMPLATE", text: heading });
  if (ev.time) {
    const [h, m] = ev.time.split(":").map(Number);
    const end = new Date(Date.UTC(occ.y, occ.m - 1, occ.d, h + 1, m));
    const endStr = `${end.getUTCFullYear()}${pad(end.getUTCMonth() + 1)}${pad(end.getUTCDate())}T${pad(end.getUTCHours())}${pad(m)}00`;
    p.set("dates", `${day}T${pad(h)}${pad(m)}00/${endStr}`);
    p.set("ctz", tz);
  } else {
    const next = new Date(Date.UTC(occ.y, occ.m - 1, occ.d + 1));
    p.set("dates", `${day}/${next.getUTCFullYear()}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`);
  }
  if (ev.repeat === "yearly") p.set("recur", "RRULE:FREQ=YEARLY");
  if (ev.notes) p.set("details", ev.notes);
  return `https://calendar.google.com/calendar/render?${p}`;
}

// Builds the EmailJS template variables for one reminder.
export function reminderParams(ev, occ, now, tz) {
  const { detail } = describe(ev, occ);
  const rel = relativeDay(occ, now, tz);                     // "Tomorrow", "Today", "In 7 days"
  const relLower = rel === "Today" || rel === "Tomorrow" ? rel.toLowerCase() : rel.replace("In", "in");
  const day = new Date(Date.UTC(occ.y, occ.m - 1, occ.d));
  const fmt = (o) => day.toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
  const name = ev.title;
  const age = detail.startsWith("turns") ? Number(detail.slice(6)) : null;
  const years = ev.type === "anniversary" && detail ? detail : "";

  let title, subject, tagline;
  switch (ev.type) {
    case "birthday":
      title = `Birthday of ${name}`;
      subject = age ? `Birthday of ${name} — turning ${age} ${relLower}` : `Birthday of ${name} is ${relLower}`;
      tagline = age ? `Turning ${age} — time to get the wishes, cake &amp; calls ready.` : `Time to get the wishes, cake &amp; calls ready.`;
      break;
    case "anniversary":
      title = `Anniversary of ${name}`;
      subject = `Anniversary of ${name}${years ? ` — ${years}` : ""} is ${relLower}`;
      tagline = years ? `${esc(years)} together — send some love their way.` : `Send some love their way.`;
      break;
    case "event":
      title = name;
      subject = `${name} — ${relLower}${ev.time ? ` at ${fmtTime(ev.time)}` : ""}`;
      tagline = ev.time ? `Starts at ${fmtTime(ev.time)}. You've got this.` : `Don't let this one slip.`;
      break;
    default:
      title = name;
      subject = `Reminder: ${name} — ${relLower}`;
      tagline = `A gentle nudge from Wishly.`;
  }

  return {
    subject,
    title,
    when: `${rel}${ev.time ? ` · ${fmtTime(ev.time)}` : ""}`,
    day: String(occ.d),
    month: fmt({ month: "short" }).toUpperCase(),
    weekday: fmt({ weekday: "long" }),
    tagline_html: tagline,
    notes_html: ev.notes
      ? `<div style="margin:22px 0 0;padding:12px 16px;border-left:3px solid #e0a458;background:#faf7f2;border-radius:0 10px 10px 0;text-align:left;font-size:14px;line-height:1.6;color:#4a413b">${esc(ev.notes).replace(/\n/g, "<br>")}</div>`
      : "",
    gcal_url: gcalUrl(ev, occ, tz, title),
  };
}
