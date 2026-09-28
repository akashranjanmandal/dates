// Web Push (phone / browser notifications) using VAPID keys.
import webpush from "web-push";

export const pushConfigured = () => Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY || "";

let ready = false;
function setup() {
  if (ready) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  ready = true;
}

export function validSubscription(s) {
  return Boolean(s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.keys?.p256dh && s.keys?.auth);
}

// Sends to every device; returns { sent, failed, gone } where `gone` lists endpoints to forget.
export async function pushToAll(subscriptions, payload) {
  setup();
  const result = { sent: 0, failed: 0, gone: [], error: "" };
  await Promise.all((subscriptions || []).map(async (sub) => {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 12 * 3600, urgency: "high" });
      result.sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) result.gone.push(sub.endpoint);
      else { result.failed++; result.error = `${e.statusCode || ""} ${e.body || e.message}`.trim().slice(0, 200); }
    }
  }));
  return result;
}
