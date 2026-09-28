// Date + reminder logic shared by the API and the scheduled reminder job.
// All reminder times are interpreted in REMINDER_TZ (default Asia/Kolkata).

// A reminder is either { d, t } — "d days before, at time t" (d = 0 means the same day) —
// or { m } — "m minutes before" a timed event. Old presets are still accepted.
const LEGACY = {
  week: { d: 7, t: "09:00" },
  eve9: { d: 1, t: "21:00" },
  morn8: { d: 0, t: "08:00" },
  hour1: { m: 60 },
};

export function normRemind(r) {
  if (typeof r === "string") r = LEGACY[r];
  if (!r || typeof r !== "object") return null;
  if (r.m != null) {
    const m = Math.round(Number(r.m));
    return m >= 5 && m <= 2880 ? { m } : null;
  }
  const d = Math.round(Number(r.d));
  if (!(d >= 0 && d <= 60) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.t || "")) return null;
  return { d, t: r.t };
}

export const remindKey = (r) => (r.m != null ? `m${r.m}` : `d${r.d}@${r.t}`);

export const TYPES = {
  birthday:    { label: "Birthday" },
  anniversary: { label: "Anniversary" },
  event:       { label: "Event" },
  other:       { label: "Reminder" },
};

// A reminder that was missed (e.g. a skipped run) is still sent if it's less than this old.
const CATCH_UP_MS = 12 * 3600e3;

export const tzName = () => process.env.REMINDER_TZ || "Asia/Kolkata";

export function validTz(tz) {
  try { return Boolean(tz) && Boolean(new Intl.DateTimeFormat("en-US", { timeZone: tz })); } catch { return false; }
}

function tzOffsetMs(ts, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ts)).map((x) => [x.type, x.value])
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

// Wall-clock time in `tz` -> UTC timestamp. m is 1-12.
export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

export function localYmd(ts, tz) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ts)).split("-").map(Number);
  return { y, m, d };
}

const clampDay = (y, m, d) => Math.min(d, new Date(Date.UTC(y, m, 0)).getUTCDate()); // Feb 29 -> Feb 28
const pad = (n) => String(n).padStart(2, "0");
export const ymd = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;

function occurrences(ev, aroundYear) {
  const [y, m, d] = ev.date.split("-").map(Number);
  if (ev.repeat !== "yearly") return [{ y, m, d }];
  return [aroundYear - 1, aroundYear, aroundYear + 1]
    .filter((yy) => ev.yearUnknown || yy >= y)
    .map((yy) => ({ y: yy, m, d: clampDay(yy, m, d) }));
}

function reminderInstant(ev, occ, r, tz) {
  if (r.m != null) {
    if (!ev.time) return null;
    const [h, mi] = ev.time.split(":").map(Number);
    return zonedToUtc(occ.y, occ.m, occ.d, h, mi, tz) - r.m * 60e3;
  }
  const base = new Date(Date.UTC(occ.y, occ.m - 1, occ.d - r.d));
  const [h, mi] = r.t.split(":").map(Number);
  return zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, mi, tz);
}

// Returns reminders whose send time has passed (within the catch-up window) and weren't sent yet.
export function computeDue(events, sent, now, tz) {
  const { y: nowY } = localYmd(now, tz);
  const due = [];
  for (const ev of events) {
    for (const raw of ev.remind || []) {
      const r = normRemind(raw);
      if (!r) continue;
      for (const occ of occurrences(ev, nowY)) {
        const at = reminderInstant(ev, occ, r, tz);
        if (at == null || at > now || now - at >= CATCH_UP_MS) continue;
        const k = `${ev.id}|${ymd(occ)}|${remindKey(r)}`;
        if (!sent[k]) due.push({ ev, occ, r, k, at });
      }
    }
  }
  return due.sort((a, b) => a.at - b.at);
}

export function describe(ev, occ) {
  const birthYear = Number(ev.date.slice(0, 4));
  let title = ev.title;
  let detail = "";
  if (ev.type === "birthday") {
    title = `${ev.title}’s birthday`;
    if (!ev.yearUnknown && occ.y > birthYear) detail = `turns ${occ.y - birthYear}`;
  } else if (ev.type === "anniversary" && !ev.yearUnknown && occ.y > birthYear) {
    detail = `${occ.y - birthYear} years`;
  }
  return { title, detail };
}

export function relativeDay(occ, now, tz) {
  const today = localYmd(now, tz);
  const diff = Math.round((Date.UTC(occ.y, occ.m - 1, occ.d) - Date.UTC(today.y, today.m - 1, today.d)) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff > 1) return `In ${diff} days`;
  return `${-diff} days ago`;
}
