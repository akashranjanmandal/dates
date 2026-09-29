// Verifies a Firebase Authentication ID token (Google sign-in) without any service-account secret:
// the signature is checked against Google's public certificates.
import { createVerify, X509Certificate } from "node:crypto";

const CERTS = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
let cache = { at: 0, certs: {} };

export const firebaseProject = () => process.env.FIREBASE_PROJECT_ID || "device-streaming-a4f3601d";
export const googleConfig = () => process.env.FIREBASE_API_KEY
  ? { apiKey: process.env.FIREBASE_API_KEY, authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${firebaseProject()}.firebaseapp.com`, projectId: firebaseProject() }
  : null;

async function certs() {
  if (Date.now() - cache.at < 3600e3 && Object.keys(cache.certs).length) return cache.certs;
  const res = await fetch(CERTS);
  if (!res.ok) throw new Error("Couldn't load Google's certificates");
  cache = { at: Date.now(), certs: await res.json() };
  return cache.certs;
}

export async function verifyGoogleToken(idToken) {
  const [h, p, sig] = String(idToken || "").split(".");
  if (!h || !p || !sig) throw new Error("Bad token");
  const head = JSON.parse(Buffer.from(h, "base64url").toString()), body = JSON.parse(Buffer.from(p, "base64url").toString());
  const pem = (await certs())[head.kid];
  if (head.alg !== "RS256" || !pem) throw new Error("Unknown signing key");
  const v = createVerify("RSA-SHA256").update(`${h}.${p}`);
  if (!v.verify(new X509Certificate(pem).publicKey, Buffer.from(sig, "base64url"))) throw new Error("Bad signature");
  const proj = firebaseProject(), now = Date.now() / 1000;
  if (body.aud !== proj || body.iss !== `https://securetoken.google.com/${proj}`) throw new Error("Wrong project");
  if (!body.sub || body.exp < now || body.iat > now + 300) throw new Error("Token expired");
  return { sub: body.sub, name: body.name || "", email: body.email || "", verified: body.email_verified !== false };
}
