// Date + reminder logic shared by the API and the scheduled reminder job.
// All reminder times are interpreted in REMINDER_TZ (default Asia/Kolkata).

export const REMINDERS = {
  week:  { label: "1 week before, 9 AM", days: -7, time: "09:00" },
  eve9:  { label: "Day before, 9 PM",    days: -1, time: "21:00" },
  morn8: { label: "Same day, 8 AM",      days: 0,  time: "08:00" },
  hour1: { label: "1 hour before",       hourBefore: true },
};

export const TYPES = {
  birthday:    { label: "Birthday" },
  anniversary: { label: "Anniversary" },
  event:       { label: "Event" },
  other:       { label: "Reminder" },
};

// A reminder that was missed (e.g. a skipped run) is still sent if it's less than this old.
const CATCH_UP_MS = 12 * 3600e3;

export const tzName = () => process.env.REMINDER_TZ || "Asia/Kolkata";

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

function reminderInstant(ev, occ, def, tz) {
  if (def.hourBefore) {
    if (!ev.time) return null;
    const [h, mi] = ev.time.split(":").map(Number);
    return zonedToUtc(occ.y, occ.m, occ.d, h, mi, tz) - 3600e3;
  }
  const base = new Date(Date.UTC(occ.y, occ.m - 1, occ.d + def.days));
  const [h, mi] = def.time.split(":").map(Number);
  return zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, mi, tz);
}

// Returns reminders whose send time has passed (within the catch-up window) and weren't sent yet.
export function computeDue(events, sent, now, tz) {
  const { y: nowY } = localYmd(now, tz);
  const due = [];
  for (const ev of events) {
    for (const key of ev.remind || []) {
      const def = REMINDERS[key];
      if (!def) continue;
      for (const occ of occurrences(ev, nowY)) {
        const at = reminderInstant(ev, occ, def, tz);
        if (at == null || at > now || now - at >= CATCH_UP_MS) continue;
        const k = `${ev.id}|${ymd(occ)}|${key}`;
        if (!sent[k]) due.push({ ev, occ, key, k });
      }
    }
  }
  return due.sort((a, b) => ymd(a.occ).localeCompare(ymd(b.occ)));
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
