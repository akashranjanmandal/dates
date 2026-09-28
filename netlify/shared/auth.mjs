import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Sessions are signed with SESSION_SECRET (falls back to ADMIN_PASSWORD so one variable is enough).
const secret = () => process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
export const authConfigured = () => Boolean(secret());

const mac = (body) => createHmac("sha256", secret()).update(body).digest("base64url");

export function sign(payload, days = 180) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + days * 864e5 })).toString("base64url");
  return `${body}.${mac(body)}`;
}

export function verify(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || !secret()) return null;
  const a = Buffer.from(sig), b = Buffer.from(mac(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: scryptSync(password, salt, 32).toString("hex") };
}

export function checkPassword(password, user) {
  const got = scryptSync(password, user.salt, 32), want = Buffer.from(user.hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export function checkAdmin(password) {
  const a = Buffer.from(String(password || "")), b = Buffer.from(process.env.ADMIN_PASSWORD || "");
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

// "  Souvik   Ghosh " -> "souvik ghosh" — names are unique case-insensitively.
export const nameKey = (name) => String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
export const validName = (name) => /^[\p{L}\p{N} ._'-]{2,32}$/u.test(String(name || "").trim());

// Blob keys for a user's records.
export const userKey = (k) => `users/${encodeURIComponent(k)}`;
export const eventsKey = (k) => `events/${encodeURIComponent(k)}`;
