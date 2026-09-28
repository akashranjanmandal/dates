// Sends email through EmailJS's REST API (https://www.emailjs.com/docs/rest-api/send/).
import { describe, relativeDay } from "./schedule.mjs";

const cfg = () => ({
  service: process.env.EMAILJS_SERVICE_ID || "service_ls3809j",
  template: process.env.EMAILJS_TEMPLATE_ID || "template_8o97oyb",
  publicKey: process.env.EMAILJS_PUBLIC_KEY,
  privateKey: process.env.EMAILJS_PRIVATE_KEY,
});

export const mailConfigured = () => Boolean(cfg().publicKey);

// `to` is the signed-in user's own reminder address (set in their Settings).
export async function sendMail(params, to) {
  const c = cfg();
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      service_id: c.service,
      template_id: c.template,
      user_id: c.publicKey,
      ...(c.privateKey && { accessToken: c.privateKey }),
      template_params: { to_email: to, app_url: (process.env.URL || "").replace(/\/$/, ""), ...params },
    }),
  });
  if (!res.ok) throw new Error(`EmailJS ${res.status}: ${await res.text()}`);
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
  const date = new Date(Date.UTC(occ.y, occ.m - 1, occ.d))
    .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
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
      tagline = `A gentle nudge from Dates.`;
  }

  const site = (process.env.URL || "").replace(/\/$/, "");
  return {
    subject,
    title,
    when: `${rel} · ${date}${ev.time ? ` · ${fmtTime(ev.time)}` : ""}`,
    tagline_html: tagline,
    icon_url: `${site}/email-icons/${ev.type in ICONS ? ev.type : "other"}.png`,
    notes_html: ev.notes
      ? `<tr><td style="padding:0 32px 8px"><div style="background:#f6f2ec;border-radius:12px;padding:14px 16px;font-size:14px;line-height:1.55;color:#4a413b"><b style="color:#1f1a17">Notes</b><br>${esc(ev.notes).replace(/\n/g, "<br>")}</div></td></tr>`
      : "",
    gcal_url: gcalUrl(ev, occ, tz, title),
  };
}

const ICONS = { birthday: 1, anniversary: 1, event: 1, other: 1 };
